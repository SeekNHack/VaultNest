import * as kdbxweb from 'kdbxweb';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CredentialsInput, KdfSettings, makeCredentials, VaultDocument } from './VaultDocument';
import { BackupOptions, backupVaultFile, currentFingerprint, readVaultFile, writeFileAtomic } from './VaultStorage';

export type ConflictKind = 'externalChangeUnreadable' | 'fileDeleted';
export type ConflictResolution = 'overwrite' | 'cancel';

export interface SessionHooks {
  backupOptions(): BackupOptions & { intervalMs: number };
  /** Called when the file changed on disk and cannot be merged automatically. */
  resolveConflict(kind: ConflictKind): Promise<ConflictResolution>;
}

export class SaveCancelledError extends Error {
  constructor() {
    super('Save cancelled; your changes are still unlocked in memory and not written to disk.');
  }
}

/**
 * Owns the decrypted state of one vault file and serialises every write.
 *
 * Saving pipeline (prevents data loss):
 *  1. serialise + encrypt the database;
 *  2. detect external changes (fingerprint) and merge them (KeePass merge semantics);
 *  3. take a rotating backup of the current file when due;
 *  4. write to a temp file, fsync, decrypt it again to verify, then atomically rename.
 */
export class VaultSession {
  private doc_: VaultDocument | undefined;
  private fingerprint: string | null = null;
  private lastBackup = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty_ = false;
  lastSaved: number | undefined;

  constructor(readonly file: string, private readonly hooks: SessionHooks) {}

  get unlocked(): boolean {
    return this.doc_ !== undefined;
  }

  get dirty(): boolean {
    return this.dirty_;
  }

  get doc(): VaultDocument {
    if (!this.doc_) throw new Error('The vault is locked.');
    return this.doc_;
  }

  /** Creates a new vault file. Fails if the file already exists. */
  static async create(file: string, name: string, creds: CredentialsInput, kdf: KdfSettings, hooks: SessionHooks): Promise<VaultSession> {
    try {
      await fs.access(file);
      throw new Error(`A file already exists at ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const session = new VaultSession(file, hooks);
    session.doc_ = VaultDocument.create(name, await makeCredentials(creds), kdf);
    session.lastBackup = Date.now();
    await session.save();
    return session;
  }

  async unlock(creds: CredentialsInput): Promise<void> {
    const snap = await readVaultFile(this.file);
    const doc = await VaultDocument.load(snap.bytes, await makeCredentials(creds));
    this.doc_ = doc;
    this.fingerprint = snap.fingerprint;
    this.lastBackup = 0; // first save after unlock always backs up
    this.dirty_ = false;
  }

  /**
   * Drops all decrypted state. Pending saves are awaited first; if the last
   * save failed, an encrypted recovery copy is written next to the backups so
   * that no change is lost, and its path is returned.
   */
  async lock(): Promise<string | undefined> {
    if (!this.doc_) return undefined;
    await this.queue.catch(() => undefined);
    let recovery: string | undefined;
    if (this.dirty_ && this.doc_) {
      try {
        await this.save();
      } catch {
        recovery = await this.writeRecoveryCopy().catch(() => undefined);
      }
    }
    this.doc_ = undefined;
    this.dirty_ = false;
    return recovery;
  }

  private async writeRecoveryCopy(): Promise<string> {
    const bytes = await this.doc.save();
    const dir = this.hooks.backupOptions().directory;
    const target = path.join(dir, `${path.basename(this.file).replace(/\.kdbx$/i, '')}.recovered-${new Date().toISOString().replace(/[:.]/g, '-')}.kdbx`);
    await writeFileAtomic(target, bytes);
    return target;
  }

  /** Applies a change in memory and persists it. */
  async mutate<T>(fn: (doc: VaultDocument) => T): Promise<T> {
    const result = fn(this.doc);
    this.dirty_ = true;
    await this.save();
    return result;
  }

  save(): Promise<void> {
    const run = this.queue.then(() => this.doSave());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the file on disk and merges its changes into the open vault (and saves the merged result). */
  async syncFromDisk(): Promise<boolean> {
    const run = this.queue.then(async () => {
      const disk = await currentFingerprint(this.file);
      if (disk === null || disk === this.fingerprint) return false;
      await this.mergeFromDisk();
      this.dirty_ = true;
      await this.doSave();
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async mergeFromDisk(): Promise<void> {
    const snap = await readVaultFile(this.file);
    let remote: VaultDocument;
    try {
      remote = await VaultDocument.load(snap.bytes, this.doc.db.credentials);
    } catch (err) {
      if (err instanceof kdbxweb.KdbxError && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
        const choice = await this.hooks.resolveConflict('externalChangeUnreadable');
        if (choice === 'cancel') throw new SaveCancelledError();
        return; // overwrite
      }
      throw err;
    }
    this.doc.merge(remote);
  }

  private async doSave(): Promise<void> {
    const doc = this.doc;
    const disk = await currentFingerprint(this.file);
    if (this.fingerprint !== null && disk === null) {
      const choice = await this.hooks.resolveConflict('fileDeleted');
      if (choice === 'cancel') throw new SaveCancelledError();
    } else if (disk !== null && disk !== this.fingerprint) {
      await this.mergeFromDisk();
    }

    const bytes = await doc.save();
    const backup = this.hooks.backupOptions();
    if (backup.enabled && disk !== null && Date.now() - this.lastBackup >= backup.intervalMs) {
      await backupVaultFile(this.file, backup);
      this.lastBackup = Date.now();
    }
    const credentials = doc.db.credentials;
    this.fingerprint = await writeFileAtomic(this.file, bytes, async (written) => {
      // Decrypt what was written with the same credentials before replacing the old file.
      await kdbxweb.Kdbx.load(written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength) as ArrayBuffer, credentials);
    });
    this.dirty_ = false;
    this.lastSaved = Date.now();
  }

  /** Writes the current (encrypted) database to another path, e.g. for export. */
  async saveCopyTo(target: string): Promise<void> {
    await this.queue.catch(() => undefined);
    await writeFileAtomic(target, await this.doc.save());
  }

  async backupNow(): Promise<string | null> {
    const backup = this.hooks.backupOptions();
    await this.queue.catch(() => undefined);
    const p = await backupVaultFile(this.file, { ...backup, enabled: true });
    this.lastBackup = Date.now();
    return p;
  }
}
