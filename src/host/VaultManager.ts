import * as kdbxweb from 'kdbxweb';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeHealth, warmHealthCache } from '../core/health/health';
import { VaultDocument } from '../core/vault/VaultDocument';
import { ConflictKind, ConflictResolution, VaultSession } from '../core/vault/VaultSession';
import type { HealthReport, VaultInfo } from '../shared/model';
import { config } from './config';

export interface VaultRef {
  id: string;
  name: string;
  path: string;
  scope: 'global' | 'workspace';
  keyFilePath?: string;
  /** Inactivity timeout for this vault in minutes (0 = never); unset uses the global setting. */
  autoLockMinutes?: number;
}

export type ChangeKind = 'registry' | 'lock' | 'content' | 'health';
export interface VaultChange {
  kind: ChangeKind;
  vaultId?: string;
}

const GLOBAL_KEY = 'vaultnest.vaults';
const WORKSPACE_KEY = 'vaultnest.workspaceVaults';
const ACTIVE_KEY = 'vaultnest.activeVault';
const MAX_UNLOCK_ATTEMPTS = 3;

/** Human readable messages for kdbxweb errors. */
export function describeError(err: unknown): string {
  if (err instanceof kdbxweb.KdbxError) {
    switch (err.code) {
      case kdbxweb.Consts.ErrorCodes.InvalidKey: return 'Wrong master password or key file.';
      case kdbxweb.Consts.ErrorCodes.BadSignature: return 'This file is not a KeePass database.';
      case kdbxweb.Consts.ErrorCodes.InvalidVersion: return 'Unsupported KeePass database version (KDBX 3.1 and 4.x are supported).';
      case kdbxweb.Consts.ErrorCodes.FileCorrupt: return 'The database file is corrupted.';
      case kdbxweb.Consts.ErrorCodes.Unsupported: return `Unsupported database feature: ${err.message.replace(/^Error\s*/, '')}`;
      default: return err.message;
    }
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'The vault file does not exist (was it moved or deleted?).';
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied while accessing the vault file.';
  return err instanceof Error ? err.message : String(err);
}

/**
 * Registry of known vault files plus their (un)locked sessions.
 * Vault paths are stored in VS Code global state (global vaults, available in
 * every window) or workspace state (vaults bound to the current workspace).
 * No secret is ever persisted by this class.
 */
export class VaultManager implements vscode.Disposable {
  private readonly sessions = new Map<string, VaultSession>();
  private readonly health = new Map<string, HealthReport>();
  private readonly emitter = new vscode.EventEmitter<VaultChange>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {}

  // ------------------------------------------------------------ registry

  refs(): VaultRef[] {
    const global = this.context.globalState.get<VaultRef[]>(GLOBAL_KEY, []).map((r) => ({ ...r, scope: 'global' as const }));
    const ws = this.context.workspaceState.get<VaultRef[]>(WORKSPACE_KEY, []).map((r) => ({ ...r, scope: 'workspace' as const }));
    return [...global, ...ws];
  }

  ref(id: string): VaultRef {
    const r = this.refs().find((v) => v.id === id);
    if (!r) throw new Error('Unknown vault.');
    return r;
  }

  private async saveRefs(refs: VaultRef[]): Promise<void> {
    const strip = (r: VaultRef) => ({ id: r.id, name: r.name, path: r.path, keyFilePath: r.keyFilePath, autoLockMinutes: r.autoLockMinutes });
    await this.context.globalState.update(GLOBAL_KEY, refs.filter((r) => r.scope === 'global').map(strip));
    await this.context.workspaceState.update(WORKSPACE_KEY, refs.filter((r) => r.scope === 'workspace').map(strip));
    this.emitter.fire({ kind: 'registry' });
  }

  async addRef(ref: Omit<VaultRef, 'id'>): Promise<VaultRef> {
    const existing = this.refs().find((r) => path.resolve(r.path) === path.resolve(ref.path));
    if (existing) return existing;
    const full: VaultRef = { ...ref, id: randomUUID() };
    await this.saveRefs([...this.refs(), full]);
    return full;
  }

  async updateRef(id: string, patch: Partial<Omit<VaultRef, 'id'>>): Promise<void> {
    await this.saveRefs(this.refs().map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async removeRef(id: string): Promise<void> {
    await this.lock(id);
    this.sessions.delete(id);
    await this.saveRefs(this.refs().filter((r) => r.id !== id));
    if (this.activeVaultId === id) await this.setActive(null);
  }

  get activeVaultId(): string | null {
    const id = this.context.workspaceState.get<string | null>(ACTIVE_KEY, null);
    const refs = this.refs();
    if (id && refs.some((r) => r.id === id)) return id;
    return refs.find((r) => this.isUnlocked(r.id))?.id ?? refs[0]?.id ?? null;
  }

  async setActive(id: string | null): Promise<void> {
    if (id === this.context.workspaceState.get<string | null>(ACTIVE_KEY, null)) return;
    await this.context.workspaceState.update(ACTIVE_KEY, id);
    this.emitter.fire({ kind: 'registry' });
  }

  defaultVaultDirectory(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'vaults');
  }

  backupDirectory(ref: VaultRef): string {
    if (config.backupLocation() === 'besideVault') return path.join(path.dirname(ref.path), '.vaultnest-backups');
    return path.join(this.context.globalStorageUri.fsPath, 'backups', ref.id);
  }

  // ------------------------------------------------------------ sessions

  session(id: string): VaultSession {
    let s = this.sessions.get(id);
    if (!s) {
      const ref = this.ref(id);
      s = new VaultSession(ref.path, this.hooksFor(id));
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Registers an already-unlocked session (used after creating a new vault). */
  adoptSession(id: string, session: VaultSession): void {
    this.sessions.set(id, session);
    this.health.delete(id);
    this.emitter.fire({ kind: 'lock', vaultId: id });
  }

  hooksFor(id: string) {
    return {
      backupOptions: () => {
        const ref = this.refs().find((r) => r.id === id);
        return {
          enabled: config.backupEnabled(),
          directory: ref ? this.backupDirectory(ref) : path.join(this.context.globalStorageUri.fsPath, 'backups', id),
          keep: config.backupCount(),
          intervalMs: config.backupIntervalMinutes() * 60_000,
        };
      },
      resolveConflict: (kind: ConflictKind) => this.resolveConflict(id, kind),
    };
  }

  private async resolveConflict(id: string, kind: ConflictKind): Promise<ConflictResolution> {
    const name = this.refs().find((r) => r.id === id)?.name ?? 'vault';
    const message = kind === 'fileDeleted'
      ? `The file of "${name}" was deleted or moved outside VS Code. Recreate it with the unlocked content?`
      : `The file of "${name}" was changed outside VS Code and cannot be opened with the current master password (was it changed elsewhere?). Overwrite the file on disk with your version? A backup of the current file is kept.`;
    const overwrite = kind === 'fileDeleted' ? 'Recreate File' : 'Overwrite';
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, overwrite);
    return choice === overwrite ? 'overwrite' : 'cancel';
  }

  isUnlocked(id: string): boolean {
    return this.sessions.get(id)?.unlocked ?? false;
  }

  unlockedIds(): string[] {
    return this.refs().filter((r) => this.isUnlocked(r.id)).map((r) => r.id);
  }

  /** The effective inactivity timeout of a vault, in minutes (0 = never). */
  autoLockMinutes(id: string): number {
    return this.ref(id).autoLockMinutes ?? config.autoLockMinutes();
  }

  hasUnlocked(): boolean {
    return this.unlockedIds().length > 0;
  }

  doc(id: string): VaultDocument {
    return this.session(id).doc;
  }

  /**
   * Prompts for the master password (and reads the key file if configured)
   * and unlocks the vault. Returns false if the user cancelled.
   */
  async unlock(id: string): Promise<boolean> {
    const ref = this.ref(id);
    const session = this.session(id);
    if (session.unlocked) return true;
    let keyFile: Uint8Array | null = null;
    if (ref.keyFilePath) {
      try {
        keyFile = new Uint8Array(await fs.readFile(ref.keyFilePath));
      } catch (err) {
        void vscode.window.showErrorMessage(`Cannot read the key file ${ref.keyFilePath}: ${describeError(err)}`);
        return false;
      }
    }
    for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
      const pw = await vscode.window.showInputBox({
        title: `Unlock ${ref.name}`,
        prompt: attempt === 1 ? `Master password for ${path.basename(ref.path)}${ref.keyFilePath ? ' (key file will be used too)' : ''}` : 'Wrong master password or key file. Try again.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Master password',
      });
      if (pw === undefined) return false;
      const password = kdbxweb.ProtectedValue.fromString(pw);
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Unlocking ${ref.name}…` }, () => session.unlock({ password, keyFile }));
        this.log.info(`Vault unlocked: ${ref.name}`);
        this.health.delete(id);
        this.emitter.fire({ kind: 'lock', vaultId: id });
        if (!session.doc.formatInfo.kdbxVersion.startsWith('4')) {
          void vscode.window.showInformationMessage(`"${ref.name}" uses the older KDBX 3.1 format. Favorites and item types require KDBX 4.`, 'Upgrade to KDBX 4')
            .then(async (c) => {
              if (!c) return;
              try {
                await this.mutate(id, (d) => d.upgradeFormat(config.kdf()));
                void vscode.window.showInformationMessage(`"${ref.name}" was upgraded to KDBX 4.`);
              } catch (err) {
                void vscode.window.showErrorMessage(`Upgrade failed: ${describeError(err)}`);
              }
            });
        }
        return true;
      } catch (err) {
        if (err instanceof kdbxweb.KdbxError && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
          this.log.warn(`Failed unlock attempt for ${ref.name}`);
          continue;
        }
        void vscode.window.showErrorMessage(`Cannot open "${ref.name}": ${describeError(err)}`);
        return false;
      }
    }
    void vscode.window.showErrorMessage(`Could not unlock "${ref.name}" after ${MAX_UNLOCK_ATTEMPTS} attempts.`);
    return false;
  }

  /** Returns true if the vault is unlocked, prompting the user to unlock it otherwise. */
  async ensureUnlocked(id: string): Promise<boolean> {
    return this.isUnlocked(id) || this.unlock(id);
  }

  async lock(id: string, reason?: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s?.unlocked) return;
    const recovery = await s.lock();
    this.health.delete(id);
    this.log.info(`Vault locked: ${this.refs().find((r) => r.id === id)?.name ?? id}${reason ? ` (${reason})` : ''}`);
    if (recovery) {
      void vscode.window.showWarningMessage(`Unsaved changes could not be written to the vault file. An encrypted recovery copy was saved to ${recovery}.`);
    }
    this.emitter.fire({ kind: 'lock', vaultId: id });
  }

  async lockAll(reason?: string): Promise<void> {
    await Promise.all(this.unlockedIds().map((id) => this.lock(id, reason)));
  }

  /** Applies a change to an unlocked vault and saves it, reporting errors to the user. */
  async mutate<T>(id: string, fn: (doc: VaultDocument) => T): Promise<T> {
    const s = this.session(id);
    try {
      return await s.mutate(fn);
    } catch (err) {
      this.log.error(`Save failed: ${describeError(err)}`);
      throw err;
    } finally {
      this.health.delete(id);
      this.emitter.fire({ kind: 'content', vaultId: id });
    }
  }

  async syncFromDisk(id: string): Promise<boolean> {
    const changed = await this.session(id).syncFromDisk();
    if (changed) {
      this.health.delete(id);
      this.emitter.fire({ kind: 'content', vaultId: id });
    }
    return changed;
  }

  private readonly warming = new Set<string>();

  /**
   * Returns the cached health report, or undefined while it is being computed
   * in the background (a 'health' change event fires when it is ready).
   */
  healthReportIfReady(id: string): HealthReport | undefined {
    const cached = this.health.get(id);
    if (cached) return cached;
    if (!this.warming.has(id)) {
      this.warming.add(id);
      void warmHealthCache(this.doc(id).passwords())
        .then(() => {
          if (!this.isUnlocked(id)) return;
          this.healthReport(id);
          this.emitter.fire({ kind: 'health', vaultId: id });
        })
        .catch((err) => this.log.warn(`Health analysis failed: ${describeError(err)}`))
        .finally(() => this.warming.delete(id));
    }
    return undefined;
  }

  healthReport(id: string): HealthReport {
    let r = this.health.get(id);
    if (!r) {
      r = analyzeHealth(id, this.doc(id).passwords(), { maxAgeDays: config.maxPasswordAgeDays() });
      this.health.set(id, r);
    }
    return r;
  }

  info(ref: VaultRef): VaultInfo {
    const s = this.sessions.get(ref.id);
    const info: VaultInfo = { id: ref.id, name: ref.name, path: ref.path, scope: ref.scope, locked: !s?.unlocked, keyFilePath: ref.keyFilePath, autoLockMinutes: ref.autoLockMinutes };
    if (s?.unlocked) {
      const d = s.doc;
      info.details = {
        ...d.formatInfo,
        entryCount: [...d.allEntries(false)].length,
        description: d.description,
        lastSaved: s.lastSaved,
      };
    }
    return info;
  }

  dispose(): void {
    // Drop decrypted state synchronously on shutdown.
    for (const s of this.sessions.values()) void s.lock();
    this.emitter.dispose();
  }
}
