import * as path from 'node:path';
import * as vscode from 'vscode';
import { ITEM_TYPE_INFO, type EntrySummary } from '../shared/model';
import { Actions } from './Actions';
import { config } from './config';
import { exportFlow, importFlow } from './services/dataFlows';
import { autoLockFlow, changeMasterPasswordFlow, createVaultFlow, openVaultFlow } from './services/vaultFlows';
import { DashboardPanel } from './views/DashboardPanel';
import type { TreeNode } from './views/VaultTreeProvider';
import { VaultTreeProvider } from './views/VaultTreeProvider';
import { describeError, VaultManager } from './VaultManager';

/** Arguments commands may receive: tree nodes, dashboard references or nothing (palette). */
type CommandArg = TreeNode | { vaultId: string; entryId?: string; folderId?: string } | vscode.Uri | undefined;

interface EntryRef {
  vaultId: string;
  entryId: string;
}

const INSERT_WARNING_KEY = 'vaultnest.insertWarningShown';

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: VaultManager,
  actions: Actions,
  tree: VaultTreeProvider,
  touch: () => void,
): void {
  const dashboard = () => DashboardPanel.show(context.extensionUri, manager, actions, touch);

  const vaultIdOf = (arg: CommandArg): string | undefined =>
    arg && !(arg instanceof vscode.Uri) && 'vaultId' in arg ? arg.vaultId : undefined;

  /** Picks a vault: from the argument, the single registered vault, or a quick pick. */
  async function resolveVault(arg: CommandArg, opts: { unlocked?: boolean; prompt?: string } = {}): Promise<string | undefined> {
    const fromArg = vaultIdOf(arg);
    let id = fromArg;
    if (!id) {
      const refs = manager.refs();
      if (refs.length === 0) {
        const create = 'Create Vault';
        const open = 'Open .kdbx';
        const c = await vscode.window.showInformationMessage('You have no vault yet.', create, open);
        if (c === create) return (await createVaultFlow(manager))?.id;
        if (c === open) return (await openVaultFlow(manager))?.id;
        return undefined;
      }
      const candidates = opts.unlocked && manager.unlockedIds().length ? refs.filter((r) => manager.isUnlocked(r.id)) : refs;
      if (candidates.length === 1) id = candidates[0].id;
      else {
        const pick = await vscode.window.showQuickPick(candidates.map((r) => ({
          label: `$(${manager.isUnlocked(r.id) ? 'unlock' : 'lock'}) ${r.name}`,
          description: path.basename(r.path), detail: r.path, id: r.id,
        })), { title: opts.prompt ?? 'Select a vault' });
        id = pick?.id;
      }
    }
    if (!id) return undefined;
    if (opts.unlocked && !(await manager.ensureUnlocked(id))) return undefined;
    return id;
  }

  /** Lists items of all unlocked vaults (unlocking one first if needed). */
  async function allEntries(): Promise<{ vaultId: string; vaultName: string; entry: EntrySummary }[] | undefined> {
    if (!manager.hasUnlocked()) {
      const id = await resolveVault(undefined, { unlocked: true, prompt: 'Unlock a vault' });
      if (!id) return undefined;
    }
    const out: { vaultId: string; vaultName: string; entry: EntrySummary }[] = [];
    for (const id of manager.unlockedIds()) {
      const name = manager.ref(id).name;
      for (const entry of manager.doc(id).listEntries()) if (!entry.trashed) out.push({ vaultId: id, vaultName: name, entry });
    }
    return out;
  }

  const btn: Record<'user' | 'pass' | 'totp' | 'url', vscode.QuickInputButton> = {
    user: { iconPath: new vscode.ThemeIcon('person'), tooltip: 'Copy username' },
    pass: { iconPath: new vscode.ThemeIcon('key'), tooltip: 'Copy password / secret' },
    totp: { iconPath: new vscode.ThemeIcon('watch'), tooltip: 'Copy verification code' },
    url: { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open URL' },
  };

  type EntryPick = vscode.QuickPickItem & { ref: EntryRef; entry: EntrySummary };

  async function pickEntry(title: string, filter: (e: EntrySummary) => boolean = () => true): Promise<EntryRef | undefined> {
    const list = await allEntries();
    if (!list) return undefined;
    const multi = manager.unlockedIds().length > 1;
    const items: EntryPick[] = list.filter((x) => filter(x.entry))
      .sort((a, b) => Number(b.entry.favorite) - Number(a.entry.favorite) || a.entry.title.localeCompare(b.entry.title))
      .map(({ vaultId, vaultName, entry }) => ({
        label: `$(${entry.favorite ? 'star-full' : ITEM_TYPE_INFO[entry.type].icon}) ${entry.title}`,
        description: [entry.username, entry.url ? safeHost(entry.url) : ''].filter(Boolean).join(' · '),
        detail: [multi ? vaultName : '', entry.folderPath, entry.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('  ·  ') || undefined,
        ref: { vaultId, entryId: entry.id },
        entry,
        buttons: [entry.username ? btn.user : undefined, entry.hasPassword ? btn.pass : undefined, entry.hasTotp ? btn.totp : undefined, entry.url ? btn.url : undefined].filter((b): b is vscode.QuickInputButton => b !== undefined),
      }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No matching items in the unlocked vaults.');
      return undefined;
    }
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<EntryPick>();
      qp.title = title;
      qp.placeholder = 'Search by name, username, website, folder or #tag';
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = items;
      let done = false;
      qp.onDidTriggerItemButton(async ({ item, button }) => {
        touch();
        const run = async () => {
          if (button === btn.user) await actions.copyField(item.ref.vaultId, item.ref.entryId, 'UserName');
          else if (button === btn.pass) await actions.copyField(item.ref.vaultId, item.ref.entryId, 'Password');
          else if (button === btn.totp) await actions.copyField(item.ref.vaultId, item.ref.entryId, 'otp');
          else if (button === btn.url) await actions.openUrl(item.entry.url);
        };
        await actions.run('Action failed', run);
        if (button === btn.url || button === btn.pass) {
          done = true;
          qp.hide();
          resolve(undefined);
        }
      });
      qp.onDidAccept(() => {
        done = true;
        const sel = qp.selectedItems[0];
        qp.hide();
        resolve(sel?.ref);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
    });
  }

  async function resolveEntry(arg: CommandArg, title: string, filter?: (e: EntrySummary) => boolean): Promise<EntryRef | undefined> {
    if (arg && !(arg instanceof vscode.Uri)) {
      if ('kind' in arg && arg.kind === 'entry') return { vaultId: arg.vaultId, entryId: arg.entry.id };
      if ('entryId' in arg && arg.entryId) return { vaultId: arg.vaultId, entryId: arg.entryId };
    }
    return pickEntry(title, filter);
  }

  function folderOf(arg: CommandArg): string | null {
    if (arg && !(arg instanceof vscode.Uri)) {
      if ('kind' in arg && arg.kind === 'folder' && !arg.trash) return arg.folderId;
      if ('folderId' in arg && arg.folderId) return arg.folderId;
    }
    return null;
  }

  async function insertIntoEditor(text: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('Open a text editor to insert the value.');
      return false;
    }
    if (!context.globalState.get<boolean>(INSERT_WARNING_KEY)) {
      const ok = 'Insert';
      const c = await vscode.window.showWarningMessage(
        'The secret will be written in plain text into the current file. Make sure the file is not committed or shared, and that it is excluded from AI/indexing tools (e.g. via .gitignore and your AI assistant\'s ignore settings).',
        { modal: true }, ok);
      if (c !== ok) return false;
      await context.globalState.update(INSERT_WARNING_KEY, true);
    }
    await editor.edit((b) => editor.selections.forEach((s) => b.replace(s, text)));
    return true;
  }

  const reg = (id: string, fn: (arg: CommandArg) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (arg: CommandArg) => {
      touch();
      try {
        await fn(arg);
      } catch (err) {
        void vscode.window.showErrorMessage(`VaultNest: ${describeError(err)}`);
      }
    }));

  // ------------------------------------------------------------ vaults
  reg('vaultnest.openDashboard', async (arg) => {
    const id = vaultIdOf(arg);
    if (id) await manager.setActive(id);
    dashboard();
  });
  reg('vaultnest.createVault', () => createVaultFlow(manager));
  reg('vaultnest.openVault', (arg) => openVaultFlow(manager, arg instanceof vscode.Uri ? arg : undefined));
  reg('vaultnest.unlock', async (arg) => {
    const locked = manager.refs().filter((r) => !manager.isUnlocked(r.id));
    let id = vaultIdOf(arg);
    if (!id && locked.length === 1) id = locked[0].id;
    id ??= await resolveVault(arg, { prompt: 'Unlock vault' });
    if (!id) return;
    await manager.setActive(id);
    if (await manager.unlock(id)) {
      if (config.openDashboardOnUnlock()) dashboard();
    }
  });
  reg('vaultnest.lock', async (arg) => {
    const id = vaultIdOf(arg) ?? (manager.unlockedIds().length === 1 ? manager.unlockedIds()[0] : await resolveVault(arg, { prompt: 'Lock vault' }));
    if (id) await manager.lock(id, 'manual');
  });
  reg('vaultnest.lockAll', async () => {
    await manager.lockAll('manual');
    await actions.clipboard.clearIfOurs();
    vscode.window.setStatusBarMessage('$(lock) All vaults locked', 3000);
  });
  reg('vaultnest.removeVault', async (arg) => {
    const id = await resolveVault(arg, { prompt: 'Remove vault from list' });
    if (!id) return;
    const ref = manager.ref(id);
    const ok = 'Remove from List';
    const c = await vscode.window.showWarningMessage(`Remove "${ref.name}" from VaultNest? The file itself is NOT deleted:\n${ref.path}`, { modal: true }, ok);
    if (c === ok) await manager.removeRef(id);
  });
  reg('vaultnest.revealVaultFile', async (arg) => {
    const id = await resolveVault(arg);
    if (id) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(manager.ref(id).path));
  });
  reg('vaultnest.changeMasterPassword', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (id) await changeMasterPasswordFlow(manager, id);
  });
  reg('vaultnest.setAutoLock', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (id) await autoLockFlow(manager, id);
  });
  reg('vaultnest.backupNow', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (!id) return;
    const p = await manager.session(id).backupNow();
    if (p) {
      const reveal = 'Reveal';
      if ((await vscode.window.showInformationMessage(`Encrypted backup saved: ${p}`, reveal)) === reveal) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
      }
    }
  });
  reg('vaultnest.openBackupFolder', async (arg) => {
    const id = await resolveVault(arg);
    if (!id) return;
    const dir = manager.backupDirectory(manager.ref(id));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  });
  reg('vaultnest.syncVault', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (!id) return;
    const changed = await manager.syncFromDisk(id);
    vscode.window.setStatusBarMessage(changed ? '$(sync) Merged changes from disk' : '$(check) Vault is up to date', 3000);
  });
  reg('vaultnest.import', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true, prompt: 'Import into vault' });
    if (id) await importFlow(manager, id);
  });
  reg('vaultnest.export', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true, prompt: 'Export vault' });
    if (id) await exportFlow(manager, id);
  });
  reg('vaultnest.emptyTrash', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (id) await actions.emptyTrash(id);
  });
  reg('vaultnest.passwordHealth', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (!id) return;
    await manager.setActive(id);
    dashboard().navigate({ view: 'health', vaultId: id });
  });
  reg('vaultnest.refresh', () => tree.refresh());
  reg('vaultnest.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hacknseek.vaultnest'));
  reg('vaultnest.clearClipboard', () => actions.clipboard.clearNow());

  // ------------------------------------------------------------ folders
  reg('vaultnest.newFolder', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true });
    if (id) await actions.createFolder(id, folderOf(arg));
  });
  reg('vaultnest.renameFolder', async (arg) => {
    const folderId = folderOf(arg);
    const id = vaultIdOf(arg);
    if (id && folderId) await actions.renameFolder(id, folderId);
  });
  reg('vaultnest.deleteFolder', async (arg) => {
    const folderId = folderOf(arg);
    const id = vaultIdOf(arg);
    if (id && folderId) await actions.deleteFolder(id, folderId);
  });

  // ------------------------------------------------------------ items
  reg('vaultnest.newItem', async (arg) => {
    const id = await resolveVault(arg, { unlocked: true, prompt: 'Add item to vault' });
    if (!id) return;
    await manager.setActive(id);
    dashboard().navigate({ view: 'items', vaultId: id, newItem: { folderId: folderOf(arg) ?? undefined } });
  });
  reg('vaultnest.openItem', async (arg) => {
    const ref = await resolveEntry(arg, 'Open item');
    if (!ref) return;
    await manager.setActive(ref.vaultId);
    dashboard().navigate({ view: 'items', vaultId: ref.vaultId, entryId: ref.entryId });
  });
  reg('vaultnest.editItem', async (arg) => {
    const ref = await resolveEntry(arg, 'Edit item');
    if (!ref) return;
    await manager.setActive(ref.vaultId);
    dashboard().navigate({ view: 'items', vaultId: ref.vaultId, entryId: ref.entryId, edit: true });
  });
  reg('vaultnest.deleteItem', async (arg) => {
    const ref = await resolveEntry(arg, 'Delete item');
    if (ref) await actions.deleteEntry(ref.vaultId, ref.entryId);
  });
  reg('vaultnest.restoreItem', async (arg) => {
    const ref = await resolveEntry(arg, 'Restore item');
    if (ref) await actions.restoreEntry(ref.vaultId, ref.entryId);
  });
  reg('vaultnest.toggleFavorite', async (arg) => {
    const ref = await resolveEntry(arg, 'Toggle favorite');
    if (ref) await actions.toggleFavorite(ref.vaultId, ref.entryId);
  });
  reg('vaultnest.copyUsername', async (arg) => {
    const ref = await resolveEntry(arg, 'Copy username', (e) => !!e.username);
    if (ref) await actions.copyField(ref.vaultId, ref.entryId, 'UserName');
  });
  reg('vaultnest.copyPassword', async (arg) => {
    const ref = await resolveEntry(arg, 'Copy password / secret', (e) => e.hasPassword);
    if (ref) await actions.copyField(ref.vaultId, ref.entryId, 'Password');
  });
  reg('vaultnest.copyTotp', async (arg) => {
    const ref = await resolveEntry(arg, 'Copy verification code', (e) => e.hasTotp);
    if (ref) await actions.copyField(ref.vaultId, ref.entryId, 'otp');
  });
  reg('vaultnest.copyUrl', async (arg) => {
    const ref = await resolveEntry(arg, 'Copy URL', (e) => !!e.url);
    if (ref) await actions.copyField(ref.vaultId, ref.entryId, 'URL');
  });
  reg('vaultnest.openUrl', async (arg) => {
    const ref = await resolveEntry(arg, 'Open URL', (e) => !!e.url);
    if (ref) await actions.openUrl(manager.doc(ref.vaultId).getEntry(ref.entryId).url);
  });
  reg('vaultnest.insertSecret', async (arg) => {
    const ref = await resolveEntry(arg, 'Insert into editor');
    if (!ref) return;
    const doc = manager.doc(ref.vaultId);
    const e = doc.getEntry(ref.entryId);
    const info = ITEM_TYPE_INFO[e.type];
    const fields = [
      e.hasPassword ? { label: `$(key) ${info.passwordLabel ?? 'Password'}`, field: 'Password' } : undefined,
      e.username ? { label: `$(person) ${info.usernameLabel ?? 'Username'}`, field: 'UserName' } : undefined,
      e.url ? { label: `$(link) ${info.urlLabel ?? 'URL'}`, field: 'URL' } : undefined,
      e.hasTotp ? { label: '$(watch) Verification code (TOTP)', field: 'otp' } : undefined,
      ...e.customFields.filter((f) => f.hasValue).map((f) => ({ label: `$(${f.protected ? 'eye-closed' : 'symbol-field'}) ${f.name}`, field: f.name })),
    ].filter((x): x is { label: string; field: string } => !!x);
    if (!fields.length) return;
    const pick = fields.length === 1 ? fields[0] : await vscode.window.showQuickPick(fields, { title: `Insert from "${e.title}"` });
    if (!pick) return;
    const value = pick.field === 'otp' ? actions.getTotp(ref.vaultId, ref.entryId)?.code ?? '' : doc.revealField(ref.entryId, pick.field);
    await insertIntoEditor(value);
  });
  reg('vaultnest.search', async () => {
    const ref = await pickEntry('VaultNest: search items');
    if (!ref) return;
    const e = manager.doc(ref.vaultId).getEntry(ref.entryId);
    const info = ITEM_TYPE_INFO[e.type];
    const choices = [
      e.hasPassword ? { label: `$(key) Copy ${info.passwordLabel ?? 'password'}`, run: () => actions.copyField(ref.vaultId, ref.entryId, 'Password') } : undefined,
      e.username ? { label: `$(person) Copy ${info.usernameLabel ?? 'username'}`, run: () => actions.copyField(ref.vaultId, ref.entryId, 'UserName') } : undefined,
      e.hasTotp ? { label: '$(watch) Copy verification code', run: () => actions.copyField(ref.vaultId, ref.entryId, 'otp') } : undefined,
      e.url ? { label: '$(link-external) Open URL', run: () => actions.openUrl(e.url) } : undefined,
      { label: '$(insert) Insert into editor…', run: () => vscode.commands.executeCommand('vaultnest.insertSecret', ref) },
      { label: '$(go-to-file) Open in dashboard', run: () => vscode.commands.executeCommand('vaultnest.openItem', ref) },
      { label: '$(edit) Edit', run: () => vscode.commands.executeCommand('vaultnest.editItem', ref) },
    ].filter((x): x is { label: string; run: () => Thenable<unknown> | Promise<unknown> } => !!x);
    const action = await vscode.window.showQuickPick(choices, { title: e.title });
    await action?.run();
  });

  // ------------------------------------------------------------ generator
  reg('vaultnest.openGenerator', () => dashboard().navigate({ view: 'generator' }));
  reg('vaultnest.generatePassword', async () => {
    let options = actions.generatorOptions();
    for (;;) {
      const g = actions.generate(options);
      const pick = await vscode.window.showQuickPick([
        { label: '$(copy) Copy', description: g.value, id: 'copy' },
        { label: '$(insert) Insert into editor', id: 'insert' },
        { label: '$(add) Save as new item…', id: 'save' },
        { label: '$(refresh) Regenerate', id: 'again' },
        { label: options.mode === 'password' ? '$(whole-word) Switch to passphrase' : '$(symbol-key) Switch to random password', id: 'mode' },
        { label: '$(settings) Open full generator…', id: 'full' },
      ], { title: `Generated: ${g.strength.label} · ~${g.strength.entropyBits} bits`, placeHolder: g.value });
      if (!pick) return;
      if (pick.id === 'again') continue;
      if (pick.id === 'mode') {
        options = { ...options, mode: options.mode === 'password' ? 'passphrase' : 'password' };
        await actions.saveGeneratorOptions(options);
        continue;
      }
      if (pick.id === 'copy') await actions.clipboard.copy(g.value, 'Password', true);
      else if (pick.id === 'insert') await insertIntoEditor(g.value);
      else if (pick.id === 'full') dashboard().navigate({ view: 'generator' });
      else if (pick.id === 'save') {
        const id = await resolveVault(undefined, { unlocked: true, prompt: 'Save to vault' });
        if (!id) return;
        await manager.setActive(id);
        dashboard().navigate({ view: 'items', vaultId: id, newItem: { password: g.value } });
      }
      return;
    }
  });
  reg('vaultnest.insertGeneratedPassword', async () => {
    const g = actions.generate();
    await insertIntoEditor(g.value);
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
