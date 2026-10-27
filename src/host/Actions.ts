import * as vscode from 'vscode';
import { generate } from '../core/generator/passwordGenerator';
import { estimateStrength } from '../core/security/strength';
import { totpCode } from '../core/security/totp';
import { DEFAULT_GENERATOR_OPTIONS, GeneratorOptions, ITEM_TYPE_INFO, StrengthResult } from '../shared/model';
import { ClipboardService } from './services/ClipboardService';
import { describeError, VaultManager } from './VaultManager';

const GENERATOR_KEY = 'passwdvault.generatorOptions';
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'sftp:', 'ssh:', 'mailto:']);

/**
 * User-facing operations shared by commands, the tree view and the dashboard.
 * Destructive operations always ask for confirmation through native VS Code dialogs.
 */
export class Actions {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: VaultManager,
    readonly clipboard: ClipboardService,
  ) {}

  // ------------------------------------------------------------ clipboard

  async copyField(vaultId: string, entryId: string, field: string): Promise<void> {
    const doc = this.manager.doc(vaultId);
    const entry = doc.getEntry(entryId);
    const info = ITEM_TYPE_INFO[entry.type];
    if (field === 'otp') {
      const params = doc.getTotpParams(entryId);
      if (!params) throw new Error('This item has no authenticator key.');
      await this.clipboard.copy(totpCode(params).code, 'Verification code', true);
      return;
    }
    const value = doc.revealField(entryId, field);
    if (!value) {
      void vscode.window.showWarningMessage('That field is empty.');
      return;
    }
    const label = field === 'Password' ? (info.passwordLabel ?? 'Password')
      : field === 'UserName' ? (info.usernameLabel ?? 'Username')
        : field === 'URL' ? 'URL' : field;
    const custom = entry.customFields.find((f) => f.name === field);
    const sensitive = field === 'Password' || (custom?.protected ?? false);
    await this.clipboard.copy(value, label, sensitive);
  }

  getTotp(vaultId: string, entryId: string): { code: string; period: number; remaining: number } | null {
    const params = this.manager.doc(vaultId).getTotpParams(entryId);
    return params ? totpCode(params) : null;
  }

  // ------------------------------------------------------------ urls

  async openUrl(raw: string): Promise<void> {
    let text = raw.trim();
    if (!text) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      void vscode.window.showErrorMessage('This URL is not valid.');
      return;
    }
    if (!SAFE_URL_SCHEMES.has(url.protocol)) {
      void vscode.window.showWarningMessage(`For safety, PasswdVault only opens web, mail and SSH links (not "${url.protocol}").`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url.toString(), true));
  }

  // ------------------------------------------------------------ entries

  async deleteEntry(vaultId: string, entryId: string): Promise<boolean> {
    const e = this.manager.doc(vaultId).getEntry(entryId);
    const permanent = e.trashed;
    const label = permanent ? 'Delete Permanently' : 'Move to Trash';
    const message = permanent
      ? `Permanently delete "${e.title}"? This cannot be undone.`
      : `Move "${e.title}" to the trash? You can restore it later.`;
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, label);
    if (choice !== label) return false;
    await this.manager.mutate(vaultId, (d) => d.deleteEntry(entryId));
    return true;
  }

  async restoreEntry(vaultId: string, entryId: string): Promise<void> {
    await this.manager.mutate(vaultId, (d) => d.restoreEntry(entryId));
  }

  async toggleFavorite(vaultId: string, entryId: string): Promise<void> {
    await this.manager.mutate(vaultId, (d) => d.setFavorite(entryId, !d.isFavorite(d.findEntry(entryId))));
  }

  async emptyTrash(vaultId: string): Promise<void> {
    const doc = this.manager.doc(vaultId);
    const count = doc.listEntries().filter((e) => e.trashed).length;
    if (!count && !doc.trashGroup?.groups.length) {
      void vscode.window.showInformationMessage('The trash is already empty.');
      return;
    }
    const label = 'Empty Trash';
    const c = await vscode.window.showWarningMessage(`Permanently delete ${count} item(s) in the trash? This cannot be undone.`, { modal: true }, label);
    if (c !== label) return;
    await this.manager.mutate(vaultId, (d) => d.emptyTrash());
  }

  // ------------------------------------------------------------ folders

  async createFolder(vaultId: string, parentId: string | null): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ title: 'New folder', prompt: 'Folder name', validateInput: (v) => (v.trim() ? undefined : 'Name required') });
    if (!name) return undefined;
    return this.manager.mutate(vaultId, (d) => d.createFolder(name, parentId));
  }

  async renameFolder(vaultId: string, folderId: string): Promise<void> {
    const doc = this.manager.doc(vaultId);
    const current = doc.listFolders().find((f) => f.id === folderId);
    if (!current || current.isTrash) return;
    const name = await vscode.window.showInputBox({ title: 'Rename folder', value: current.name, validateInput: (v) => (v.trim() ? undefined : 'Name required') });
    if (!name || name === current.name) return;
    await this.manager.mutate(vaultId, (d) => d.renameFolder(folderId, name));
    if (current.isRoot) await this.manager.updateRef(vaultId, { name: name.trim() });
  }

  async deleteFolder(vaultId: string, folderId: string): Promise<void> {
    const doc = this.manager.doc(vaultId);
    const folder = doc.listFolders().find((f) => f.id === folderId);
    if (!folder || folder.isRoot || folder.isTrash) return;
    const label = 'Move to Trash';
    const c = await vscode.window.showWarningMessage(`Move the folder "${folder.name}" and everything in it to the trash?`, { modal: true }, label);
    if (c !== label) return;
    await this.manager.mutate(vaultId, (d) => d.deleteFolder(folderId));
  }

  // ------------------------------------------------------------ generator

  generatorOptions(): GeneratorOptions {
    return { ...DEFAULT_GENERATOR_OPTIONS, ...this.context.globalState.get<Partial<GeneratorOptions>>(GENERATOR_KEY, {}) };
  }

  async saveGeneratorOptions(options: GeneratorOptions): Promise<void> {
    await this.context.globalState.update(GENERATOR_KEY, options);
  }

  generate(options: GeneratorOptions = this.generatorOptions()): { value: string; strength: StrengthResult } {
    const r = generate(options);
    return { value: r.value, strength: estimateStrength(r.value, [], r.entropyBits) };
  }

  async run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`${what}: ${describeError(err)}`);
      return undefined;
    }
  }
}
