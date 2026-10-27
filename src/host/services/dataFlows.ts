import * as kdbxweb from 'kdbxweb';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { exportBitwardenCsv, exportPasswdManagerCsv } from '../../core/io/exporters';
import { IMPORT_FORMATS, ImportFormat, parseImport } from '../../core/io/importers';
import { makeCredentials, VaultDocument } from '../../core/vault/VaultDocument';
import { readVaultFile, writeFileAtomic } from '../../core/vault/VaultStorage';
import { describeError, VaultManager } from '../VaultManager';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export async function importFlow(manager: VaultManager, vaultId: string): Promise<void> {
  if (!(await manager.ensureUnlocked(vaultId))) return;
  const format = await vscode.window.showQuickPick(IMPORT_FORMATS.map((f) => ({ label: f.label, detail: f.detail, id: f.id, ext: f.extensions })), {
    title: `Import into "${manager.ref(vaultId).name}"`, ignoreFocusOut: true,
  });
  if (!format) return;
  const files = await vscode.window.showOpenDialog({ title: `Select ${format.label} file`, canSelectMany: false, filters: { [format.label]: format.ext, 'All files': ['*'] } });
  const file = files?.[0]?.fsPath;
  if (!file) return;
  const folderName = `Imported ${new Date().toISOString().slice(0, 10)}`;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_IMPORT_BYTES) throw new Error('The file is too large to import.');
    let count: number;
    if (format.id === 'kdbx') {
      const snap = await readVaultFile(file);
      const pw = await vscode.window.showInputBox({ title: `Master password of ${path.basename(file)}`, password: true, ignoreFocusOut: true });
      if (pw === undefined) return;
      let keyFile: Uint8Array | null = null;
      const useKey = await vscode.window.showQuickPick(['No key file', 'Use a key file…'], { title: 'Key file', ignoreFocusOut: true });
      if (!useKey) return;
      if (useKey !== 'No key file') {
        const k = await vscode.window.showOpenDialog({ title: 'Select key file', canSelectMany: false });
        if (!k?.[0]) return;
        keyFile = new Uint8Array(await fs.readFile(k[0].fsPath));
      }
      const other = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Decrypting database…' },
        async () => VaultDocument.load(snap.bytes, await makeCredentials({ password: kdbxweb.ProtectedValue.fromString(pw), keyFile })));
      count = await manager.mutate(vaultId, (d) => d.importVault(other, folderName));
    } else {
      const text = await fs.readFile(file, 'utf8');
      const items = parseImport(format.id as ImportFormat, text);
      if (items.length === 0) {
        void vscode.window.showWarningMessage('No items were found in the file.');
        return;
      }
      count = await manager.mutate(vaultId, (d) => d.importItems(items, folderName));
    }
    const del = 'Delete Source File…';
    const isPlain = format.id !== 'kdbx';
    const choice = await vscode.window.showInformationMessage(
      `Imported ${count} item(s) into the folder "${folderName}".${isPlain ? ' The source file is NOT encrypted: delete it now that it is imported.' : ''}`,
      ...(isPlain ? [del] : []));
    if (choice === del) {
      const confirm = await vscode.window.showWarningMessage(`Delete ${file}? It will be moved to the system trash when possible.`, { modal: true }, 'Delete');
      if (confirm === 'Delete') await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Import failed: ${describeError(err)}`);
  }
}

export async function exportFlow(manager: VaultManager, vaultId: string): Promise<void> {
  if (!(await manager.ensureUnlocked(vaultId))) return;
  const ref = manager.ref(vaultId);
  const pick = await vscode.window.showQuickPick([
    { label: '$(lock) KeePass database (.kdbx)', detail: 'Encrypted copy with the same master password — recommended', id: 'kdbx' },
    { label: '$(warning) PasswdManager CSV (unencrypted)', detail: 'All fields, folders and tags in plain text', id: 'pvcsv' },
    { label: '$(warning) Bitwarden CSV (unencrypted)', detail: 'For importing into Bitwarden or other managers', id: 'bwcsv' },
  ], { title: `Export "${ref.name}"`, ignoreFocusOut: true });
  if (!pick) return;
  if (pick.id !== 'kdbx') {
    const go = 'Export Unencrypted';
    const c = await vscode.window.showWarningMessage(
      'Unencrypted exports contain ALL your passwords in plain text. Anyone (or any program, backup or AI tool) with access to the file can read them. Store it safely and delete it as soon as possible. Avoid opening it in spreadsheet software.',
      { modal: true }, go);
    if (c !== go) return;
    // Re-authenticate before exporting secrets in clear.
    const pw = await vscode.window.showInputBox({ title: 'Confirm master password to export', password: true, ignoreFocusOut: true });
    if (pw === undefined) return;
    const probe = await makeCredentials({ password: kdbxweb.ProtectedValue.fromString(pw), keyFile: ref.keyFilePath ? new Uint8Array(await fs.readFile(ref.keyFilePath)) : null });
    const [a, b] = await Promise.all([probe.getHash(), manager.doc(vaultId).db.credentials.getHash()]);
    if (!kdbxweb.ByteUtils.arrayBufferEquals(a, b)) {
      void vscode.window.showErrorMessage('Wrong master password.');
      return;
    }
  }
  const ext = pick.id === 'kdbx' ? 'kdbx' : 'csv';
  const target = await vscode.window.showSaveDialog({
    title: 'Export to', filters: pick.id === 'kdbx' ? { 'KeePass database': ['kdbx'] } : { CSV: ['csv'] },
    defaultUri: vscode.Uri.file(path.join(path.dirname(ref.path), `${ref.name}-export.${ext}`)),
  });
  if (!target) return;
  if (path.resolve(target.fsPath) === path.resolve(ref.path)) {
    void vscode.window.showErrorMessage('Choose a different file than the vault itself.');
    return;
  }
  try {
    if (pick.id === 'kdbx') {
      await manager.session(vaultId).saveCopyTo(target.fsPath);
    } else {
      const items = manager.doc(vaultId).exportItems();
      const csv = pick.id === 'pvcsv' ? exportPasswdManagerCsv(items) : exportBitwardenCsv(items);
      await writeFileAtomic(target.fsPath, new TextEncoder().encode(csv));
    }
    void vscode.window.showInformationMessage(`Exported "${ref.name}" to ${target.fsPath}.`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Export failed: ${describeError(err)}`);
  }
}
