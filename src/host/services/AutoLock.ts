import * as vscode from 'vscode';
import { config } from '../config';

/**
 * Locks each vault after its own period of inactivity in VS Code and, optionally,
 * all of them when the window loses focus. "Activity" is any interaction with editors,
 * terminals, the window, or VaultNest itself.
 */
export class AutoLock implements vscode.Disposable {
  private lastActivity = Date.now();
  private readonly interval: NodeJS.Timeout;
  private blurTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly unlocked: () => { id: string; minutes: number }[],
    private readonly lock: (ids: string[], reason: string) => Promise<void>,
  ) {
    const touch = () => this.touch();
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(touch),
      vscode.window.onDidChangeActiveTextEditor(touch),
      vscode.window.onDidChangeVisibleTextEditors(touch),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) touch();
      }),
      vscode.window.onDidChangeActiveTerminal(touch),
      vscode.window.onDidChangeWindowState((s) => this.onWindowState(s)),
    );
    this.interval = setInterval(() => void this.check(), 10_000);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  private onWindowState(state: vscode.WindowState): void {
    if (state.focused) {
      this.touch();
      if (this.blurTimer) clearTimeout(this.blurTimer);
      this.blurTimer = undefined;
      return;
    }
    if (!config.lockOnWindowBlur() || !this.unlocked().length) return;
    const lockAll = () => void this.lock(this.unlocked().map((v) => v.id), 'window lost focus');
    const grace = config.blurGraceSeconds();
    if (grace === 0) lockAll();
    else this.blurTimer = setTimeout(lockAll, grace * 1000);
  }

  private async check(): Promise<void> {
    const idle = Date.now() - this.lastActivity;
    for (const { id, minutes } of this.unlocked()) {
      if (minutes > 0 && idle >= minutes * 60_000) await this.lock([id], `inactive for ${minutes} min`);
    }
  }

  dispose(): void {
    clearInterval(this.interval);
    if (this.blurTimer) clearTimeout(this.blurTimer);
    for (const d of this.disposables) d.dispose();
  }
}
