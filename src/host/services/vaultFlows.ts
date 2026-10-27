import * as kdbxweb from 'kdbxweb';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { VaultSession } from '../../core/vault/VaultSession';
import { estimateStrength } from '../../core/security/strength';
import { config } from '../config';
import { describeError, VaultManager, VaultRef } from '../VaultManager';

const MIN_MASTER_LENGTH = 8;

/**
 * Asks for a new master password twice, with live strength feedback.
 * Returns a ProtectedValue (the plaintext string is not kept by us).
 */
export async function askNewMasterPassword(title: string): Promise<kdbxweb.ProtectedValue | undefined> {
  const minScore = config.minMasterPasswordScore();
  for (;;) {
    const first = await vscode.window.showInputBox({
      title,
      prompt: 'Choose a strong master password. It cannot be recovered if you forget it.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return undefined;
        if (v.length < MIN_MASTER_LENGTH) return { message: `At least ${MIN_MASTER_LENGTH} characters`, severity: vscode.InputBoxValidationSeverity.Error };
        const s = estimateStrength(v);
        const text = `Strength: ${s.label} (${s.crackTime} to crack offline)${s.warning ? ` — ${s.warning}` : ''}`;
        return { message: text, severity: s.score < minScore ? vscode.InputBoxValidationSeverity.Warning : vscode.InputBoxValidationSeverity.Info };
      },
    });
    if (first === undefined) return undefined;
    if (first.length < MIN_MASTER_LENGTH) continue;
    const confirm = await vscode.window.showInputBox({ title, prompt: 'Confirm the master password', password: true, ignoreFocusOut: true });
    if (confirm === undefined) return undefined;
    if (confirm !== first) {
      void vscode.window.showErrorMessage('The passwords do not match. Please try again.');
      continue;
    }
    const strength = estimateStrength(first);
    if (strength.score < minScore) {
      const use = 'Use Anyway';
      const choice = await vscode.window.showWarningMessage(
        `This master password is ${strength.label.toLowerCase()} (estimated ${strength.crackTime} to crack offline). Your whole vault depends on it.`,
        { modal: true }, use, 'Choose Another');
      if (choice !== use) continue;
    }
    return kdbxweb.ProtectedValue.fromString(first);
  }
}

async function askScope(): Promise<'global' | 'workspace' | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) return 'global';
  const pick = await vscode.window.showQuickPick([
    { label: '$(globe) Global', description: 'Available in every VS Code window (recommended)', scope: 'global' as const },
    { label: '$(folder) This workspace only', description: 'Listed only when this workspace is open', scope: 'workspace' as const },
  ], { title: 'Where should this vault be listed?', ignoreFocusOut: true });
  return pick?.scope;
}

function safeFileName(name: string): string {
  return name.replace(/[^\w\- .]+/g, '_').trim().slice(0, 80) || 'vault';
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

export async function createVaultFlow(manager: VaultManager): Promise<VaultRef | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Create Vault (1/3)', prompt: 'Vault name', value: manager.refs().length ? '' : 'Personal', ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required'),
  });
  if (!name) return undefined;

  const where = await vscode.window.showQuickPick([
    { label: '$(lock) Private extension storage', description: 'Recommended', detail: 'Stored in VS Code\'s private storage for this extension', id: 'default' },
    { label: '$(folder-opened) Choose a location…', detail: 'e.g. a synced folder, to open it with KeePassXC on other devices', id: 'custom' },
  ], { title: 'Create Vault (2/3): location', ignoreFocusOut: true });
  if (!where) return undefined;

  let file: string;
  if (where.id === 'default') {
    const dir = manager.defaultVaultDirectory();
    file = path.join(dir, `${safeFileName(name)}.kdbx`);
    for (let i = 2; await exists(file); i++) file = path.join(dir, `${safeFileName(name)} ${i}.kdbx`);
  } else {
    const uri = await vscode.window.showSaveDialog({
      title: 'Save new vault as',
      filters: { 'KeePass database': ['kdbx'] },
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), `${safeFileName(name)}.kdbx`)),
    });
    if (!uri) return undefined;
    file = uri.fsPath.toLowerCase().endsWith('.kdbx') ? uri.fsPath : `${uri.fsPath}.kdbx`;
    if (await exists(file)) {
      void vscode.window.showErrorMessage('A file already exists at that location. Use "Open Existing Vault" to add it, or choose another name.');
      return undefined;
    }
    if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))) {
      const ok = 'Create Here';
      const c = await vscode.window.showWarningMessage('The vault will be created inside your workspace. Make sure it is not committed to a public repository (it is encrypted, but offline guessing attacks are possible against weak master passwords).', { modal: true }, ok);
      if (c !== ok) return undefined;
    }
  }

  const scope = await askScope();
  if (!scope) return undefined;
  const password = await askNewMasterPassword('Create Vault (3/3): master password');
  if (!password) return undefined;

  try {
    const ref = await manager.addRef({ name: name.trim(), path: file, scope });
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating vault "${name}"…` },
      () => VaultSession.create(file, name.trim(), { password }, config.kdf(), manager.hooksFor(ref.id)),
    );
    manager.adoptSession(ref.id, session);
    await manager.setActive(ref.id);
    void vscode.window.showInformationMessage(`Vault "${name}" created and unlocked. Remember your master password: it cannot be recovered.`);
    return ref;
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not create the vault: ${describeError(err)}`);
    return undefined;
  }
}

export async function openVaultFlow(manager: VaultManager, uri?: vscode.Uri): Promise<VaultRef | undefined> {
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({ title: 'Open KeePass database', canSelectMany: false, filters: { 'KeePass database': ['kdbx'], 'All files': ['*'] } });
    uri = picked?.[0];
  }
  if (!uri) return undefined;
  const existing = manager.refs().find((r) => path.resolve(r.path) === path.resolve(uri!.fsPath));
  if (existing) {
    await manager.setActive(existing.id);
    await manager.ensureUnlocked(existing.id);
    return existing;
  }
  const keyChoice = await vscode.window.showQuickPick([
    { label: 'Master password only', id: 'none' },
    { label: 'Master password + key file…', id: 'key' },
  ], { title: 'How is this database protected?', ignoreFocusOut: true });
  if (!keyChoice) return undefined;
  let keyFilePath: string | undefined;
  if (keyChoice.id === 'key') {
    const key = await vscode.window.showOpenDialog({ title: 'Select key file', canSelectMany: false });
    if (!key?.[0]) return undefined;
    keyFilePath = key[0].fsPath;
  }
  const scope = await askScope();
  if (!scope) return undefined;
  const ref = await manager.addRef({ name: path.basename(uri.fsPath).replace(/\.kdbx$/i, ''), path: uri.fsPath, scope, keyFilePath });
  await manager.setActive(ref.id);
  const ok = await manager.unlock(ref.id);
  if (ok) {
    const dbName = manager.doc(ref.id).name;
    if (dbName && dbName !== ref.name) await manager.updateRef(ref.id, { name: dbName });
  }
  return ref;
}

export async function changeMasterPasswordFlow(manager: VaultManager, id: string): Promise<void> {
  if (!(await manager.ensureUnlocked(id))) return;
  const ref = manager.ref(id);
  // Re-authenticate: an unlocked, unattended VS Code must not allow a silent takeover.
  const current = await vscode.window.showInputBox({ title: `Change master password: ${ref.name}`, prompt: 'Current master password', password: true, ignoreFocusOut: true });
  if (current === undefined) return;
  const doc = manager.doc(id);
  const probe = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(current), ref.keyFilePath ? new Uint8Array(await fs.readFile(ref.keyFilePath)) : null);
  await probe.ready;
  const [a, b] = await Promise.all([probe.getHash(), doc.db.credentials.getHash()]);
  if (!kdbxweb.ByteUtils.arrayBufferEquals(a, b)) {
    void vscode.window.showErrorMessage('The current master password is not correct.');
    return;
  }
  const password = await askNewMasterPassword(`New master password: ${ref.name}`);
  if (!password) return;
  const keyFile = ref.keyFilePath ? new Uint8Array(await fs.readFile(ref.keyFilePath)) : null;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Re-encrypting vault…' }, async () => {
      await doc.changeCredentials({ password, keyFile }, config.kdf());
      await manager.mutate(id, () => undefined);
    });
    void vscode.window.showInformationMessage(`Master password of "${ref.name}" changed. Other devices must use the new password; older backups still open with the old one.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not change the master password: ${describeError(err)}`);
  }
}
