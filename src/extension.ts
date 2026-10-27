import * as kdbxweb from 'kdbxweb';
import * as vscode from 'vscode';
import { VaultSession } from './core/vault/VaultSession';
import { Actions } from './host/Actions';
import { registerCommands } from './host/commands';
import { AutoLock } from './host/services/AutoLock';
import { ClipboardService } from './host/services/ClipboardService';
import { DashboardPanel } from './host/views/DashboardPanel';
import { StatusBar } from './host/views/StatusBar';
import { VaultTreeProvider } from './host/views/VaultTreeProvider';
import { VaultManager } from './host/VaultManager';

let manager: VaultManager | undefined;
let clipboard: ClipboardService | undefined;

/**
 * Entry point. Every vault starts locked: decrypted data only ever lives in
 * the memory of this extension host process, and is dropped on lock/exit.
 */
export interface TestApi {
  manager: VaultManager;
  actions: Actions;
  tree: VaultTreeProvider;
  autoLock: AutoLock;
  kdbxweb: typeof kdbxweb;
  VaultSession: typeof VaultSession;
  dashboard: () => DashboardPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const log = vscode.window.createOutputChannel('VaultNest', { log: true });
  manager = new VaultManager(context, log);
  clipboard = new ClipboardService();
  const tree = new VaultTreeProvider(manager);
  const m = manager;
  const autoLock = new AutoLock(() => m.unlockedIds().map((id) => ({ id, minutes: m.autoLockMinutes(id) })), async (ids, reason) => {
    await Promise.all(ids.map((id) => m.lock(id, reason)));
    await clipboard?.clearIfOurs();
    vscode.window.setStatusBarMessage(`$(lock) VaultNest locked (${reason})`, 5000);
  });
  const actions = new Actions(context, manager, clipboard);

  const treeView = vscode.window.createTreeView('vaultnest.vaults', { treeDataProvider: tree, showCollapseAll: true });
  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', 'vaultnest.hasVaults', m.refs().length > 0);
    void vscode.commands.executeCommand('setContext', 'vaultnest.hasUnlocked', m.hasUnlocked());
    void vscode.commands.executeCommand('setContext', 'vaultnest.hasLocked', m.refs().some((r) => !m.isUnlocked(r.id)));
    treeView.message = undefined;
  };
  updateContext();

  context.subscriptions.push(
    log, manager, clipboard, tree, treeView, autoLock, new StatusBar(manager),
    manager.onDidChange(updateContext),
    treeView.onDidChangeVisibility(() => autoLock.touch()),
    treeView.onDidChangeSelection(() => autoLock.touch()),
  );
  registerCommands(context, manager, actions, tree, () => autoLock.touch());
  log.info('VaultNest activated. All vaults are locked.');
  // Internals are exposed to the integration tests only; never to other extensions in production.
  return context.extensionMode === vscode.ExtensionMode.Test ? { manager, actions, tree, autoLock, kdbxweb, VaultSession, dashboard: () => DashboardPanel.current } : undefined;
}

export async function deactivate(): Promise<void> {
  // Flush pending saves and drop decrypted data before the extension host exits.
  await manager?.lockAll('VS Code is closing');
  await clipboard?.clearIfOurs();
}
