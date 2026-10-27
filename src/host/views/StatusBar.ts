import * as vscode from 'vscode';
import { config } from '../config';
import { VaultManager } from '../VaultManager';

/** Status bar indicator showing whether any vault is unlocked; click to lock/unlock. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('passwdmanager.status', vscode.StatusBarAlignment.Right, 100);
  private readonly subs: vscode.Disposable[];

  constructor(private readonly manager: VaultManager) {
    this.item.name = 'PasswdManager';
    this.subs = [
      manager.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => { if (config.affects(e, 'ui.showStatusBar')) this.update(); }),
    ];
    this.update();
  }

  update(): void {
    const refs = this.manager.refs();
    if (!config.showStatusBar() || refs.length === 0) {
      this.item.hide();
      return;
    }
    const unlocked = this.manager.unlockedIds();
    if (unlocked.length) {
      this.item.text = `$(unlock) ${unlocked.length === 1 ? this.manager.ref(unlocked[0]).name : `${unlocked.length} vaults`}`;
      this.item.tooltip = 'PasswdManager: unlocked — click to lock all vaults';
      this.item.command = 'passwdmanager.lockAll';
    } else {
      this.item.text = '$(lock) PasswdManager';
      this.item.tooltip = 'PasswdManager: locked — click to unlock';
      this.item.command = 'passwdmanager.unlock';
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    for (const s of this.subs) s.dispose();
  }
}
