import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { estimateStrength } from '../../core/security/strength';
import type { EntrySummary } from '../../shared/model';
import type { DashboardState, HostEvent, HostMessage, RpcMethod, RpcMethods, RpcRequest, VaultCommand } from '../../shared/protocol';
import { Actions } from '../Actions';
import { config } from '../config';
import { describeError, VaultManager } from '../VaultManager';
import { validateRequest } from './rpcValidation';

type Handler<M extends RpcMethod> = (params: RpcMethods[M][0]) => Promise<RpcMethods[M][1]> | RpcMethods[M][1];

/**
 * The main dashboard, a singleton webview panel.
 *
 * Security model:
 *  - strict CSP (no remote content, nonce-only scripts, no inline handlers);
 *  - local resources restricted to dist/media of the extension;
 *  - every inbound message is schema-validated; only whitelisted RPC methods exist;
 *  - secrets are never pushed: the webview must explicitly request `reveal` for a
 *    single field after a user action; copying happens in the extension host.
 */
export class DashboardPanel implements vscode.Disposable {
  static current: DashboardPanel | undefined;
  private static readonly viewType = 'passwdvault.dashboard';

  private readonly disposables: vscode.Disposable[] = [];
  private stateTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private pending: HostEvent[] = [];

  static show(extensionUri: vscode.Uri, manager: VaultManager, actions: Actions, touch: () => void): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(DashboardPanel.viewType, 'PasswdVault', vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      enableForms: false,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    DashboardPanel.current = new DashboardPanel(panel, extensionUri, manager, actions, touch);
    return DashboardPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly manager: VaultManager,
    private readonly actions: Actions,
    private readonly touch: () => void,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'activitybar.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      manager.onDidChange((c) => {
        if (c.kind === 'lock' && c.vaultId && !manager.isUnlocked(c.vaultId)) this.post({ kind: 'event', type: 'locked', vaultId: c.vaultId });
        this.scheduleState();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => { if (config.affects(e)) this.scheduleState(); }),
    );
  }

  navigate(event: Omit<Extract<HostEvent, { type: 'navigate' }>, 'kind' | 'type'>): void {
    this.post({ kind: 'event', type: 'navigate', ...event });
  }

  private post(msg: HostMessage): void {
    if (!this.ready && msg.kind === 'event') {
      this.pending.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private scheduleState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      if (this.ready) this.post({ kind: 'event', type: 'state', state: this.buildState() });
    }, 30);
  }

  buildState(): DashboardState {
    const refs = this.manager.refs();
    const activeVaultId = this.manager.activeVaultId;
    const state: DashboardState = {
      vaults: refs.map((r) => this.manager.info(r)),
      activeVaultId,
      folders: [],
      entries: [],
      tags: [],
      prefs: { showPasswordStrength: config.showPasswordStrength(), clipboardClearSeconds: config.clipboardClearSeconds() },
    };
    if (activeVaultId && this.manager.isUnlocked(activeVaultId)) {
      const doc = this.manager.doc(activeVaultId);
      let issues = new Map<string, EntrySummary['issues']>();
      try {
        issues = new Map(this.manager.healthReport(activeVaultId).items.map((i) => [i.id, i.issues]));
      } catch {
        // health is best-effort
      }
      state.folders = doc.listFolders();
      state.entries = doc.listEntries().map((e) => ({ ...e, vaultId: activeVaultId, issues: issues.get(e.id) ?? [] }));
      state.tags = doc.allTags();
    }
    return state;
  }

  private async onMessage(raw: unknown): Promise<void> {
    let req: RpcRequest;
    try {
      req = validateRequest(raw);
    } catch (err) {
      const id = typeof (raw as { id?: unknown })?.id === 'number' ? (raw as { id: number }).id : -1;
      this.post({ kind: 'response', id, ok: false, error: (err as Error).message });
      return;
    }
    this.touch();
    try {
      const handler = this.handlers[req.method] as Handler<RpcMethod>;
      const result = await handler(req.params as never);
      this.post({ kind: 'response', id: req.id, ok: true, result });
      if (req.method === 'ready') {
        this.ready = true;
        for (const e of this.pending.splice(0)) this.post(e);
      }
    } catch (err) {
      this.post({ kind: 'response', id: req.id, ok: false, error: describeError(err) });
    }
  }

  private requireUnlocked(vaultId: string): void {
    if (!this.manager.isUnlocked(vaultId)) throw new Error('The vault is locked.');
  }

  private readonly handlers: { [M in RpcMethod]: Handler<M> } = {
    ready: () => {
      this.ready = true;
      return this.buildState();
    },
    setActiveVault: async ({ vaultId }) => {
      this.manager.ref(vaultId);
      await this.manager.setActive(vaultId);
      this.scheduleState();
    },
    unlock: async ({ vaultId }) => {
      await this.manager.setActive(vaultId);
      const ok = await this.manager.unlock(vaultId);
      this.scheduleState();
      return ok;
    },
    lock: ({ vaultId }) => this.manager.lock(vaultId, 'manual'),
    createVault: async () => { await vscode.commands.executeCommand('passwdvault.createVault'); },
    openVault: async () => { await vscode.commands.executeCommand('passwdvault.openVault'); },
    getEntry: ({ vaultId, entryId }) => {
      this.requireUnlocked(vaultId);
      return { ...this.manager.doc(vaultId).getEntry(entryId), vaultId };
    },
    reveal: ({ vaultId, entryId, field }) => {
      this.requireUnlocked(vaultId);
      return this.manager.doc(vaultId).revealField(entryId, field);
    },
    copyField: ({ vaultId, entryId, field }) => {
      this.requireUnlocked(vaultId);
      return this.actions.copyField(vaultId, entryId, field);
    },
    copyText: ({ text, sensitive }) => this.actions.clipboard.copy(text, sensitive ? 'Password' : 'Text', sensitive),
    getTotp: ({ vaultId, entryId }) => {
      this.requireUnlocked(vaultId);
      return this.actions.getTotp(vaultId, entryId);
    },
    openUrl: ({ url }) => this.actions.openUrl(url),
    saveEntry: ({ vaultId, entryId, input }) => {
      this.requireUnlocked(vaultId);
      return this.manager.mutate(vaultId, (d) => d.saveEntry(entryId, input));
    },
    deleteEntry: ({ vaultId, entryId }) => this.actions.deleteEntry(vaultId, entryId),
    restoreEntry: ({ vaultId, entryId }) => this.actions.restoreEntry(vaultId, entryId),
    toggleFavorite: ({ vaultId, entryId }) => this.actions.toggleFavorite(vaultId, entryId),
    moveEntry: ({ vaultId, entryId, folderId }) => this.manager.mutate(vaultId, (d) => d.moveEntry(entryId, folderId)),
    emptyTrash: ({ vaultId }) => this.actions.emptyTrash(vaultId),
    createFolder: async ({ vaultId, parentId }) => { await this.actions.createFolder(vaultId, parentId); },
    renameFolder: ({ vaultId, folderId }) => this.actions.renameFolder(vaultId, folderId),
    deleteFolder: ({ vaultId, folderId }) => this.actions.deleteFolder(vaultId, folderId),
    generate: ({ options }) => this.actions.generate(options),
    getGeneratorOptions: () => this.actions.generatorOptions(),
    saveGeneratorOptions: ({ options }) => this.actions.saveGeneratorOptions(options),
    strength: ({ value }) => estimateStrength(value),
    health: ({ vaultId }) => {
      this.requireUnlocked(vaultId);
      return this.manager.healthReport(vaultId);
    },
    vaultCommand: ({ vaultId, command }) => this.vaultCommand(vaultId, command),
    openSettings: async () => { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:SeekNHack.passwdvault'); },
  };

  private async vaultCommand(vaultId: string, command: VaultCommand): Promise<void> {
    const arg = { vaultId };
    switch (command) {
      case 'changeMasterPassword': await vscode.commands.executeCommand('passwdvault.changeMasterPassword', arg); break;
      case 'backupNow': await vscode.commands.executeCommand('passwdvault.backupNow', arg); break;
      case 'openBackupFolder': await vscode.commands.executeCommand('passwdvault.openBackupFolder', arg); break;
      case 'sync': await vscode.commands.executeCommand('passwdvault.syncVault', arg); break;
      case 'import': await vscode.commands.executeCommand('passwdvault.import', arg); break;
      case 'export': await vscode.commands.executeCommand('passwdvault.export', arg); break;
      case 'remove': await vscode.commands.executeCommand('passwdvault.removeVault', arg); break;
      case 'reveal': await vscode.commands.executeCommand('passwdvault.revealVaultFile', arg); break;
      case 'rename': {
        this.requireUnlocked(vaultId);
        await this.actions.renameFolder(vaultId, this.manager.doc(vaultId).root.uuid.id);
        break;
      }
      case 'editDescription': {
        this.requireUnlocked(vaultId);
        const value = await vscode.window.showInputBox({ title: 'Vault description', value: this.manager.doc(vaultId).description });
        if (value !== undefined) await this.manager.mutate(vaultId, (d) => { d.description = value; });
        break;
      }
      case 'upgradeFormat': {
        this.requireUnlocked(vaultId);
        const ok = 'Upgrade';
        const c = await vscode.window.showWarningMessage('Upgrade this vault to KDBX 4 with Argon2id? KeePass 2.35+, KeePassXC 2.3+ and most modern clients support it.', { modal: true }, ok);
        if (c === ok) await this.manager.mutate(vaultId, (d) => d.upgradeFormat(config.kdf()));
        break;
      }
    }
    this.scheduleState();
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(18).toString('base64');
    const asset = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', p));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('media/codicon.css')}" nonce="${nonce}">
<link rel="stylesheet" href="${asset('webview.css')}" nonce="${nonce}">
<title>PasswdVault</title>
</head>
<body>
<div id="app" role="application" aria-label="PasswdVault"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}
