import * as vscode from 'vscode';
import { config } from '../config';

/**
 * Locks all vaults after a period of inactivity in VS Code and, optionally,
 * when the window loses focus. "Activity" is any interaction with editors,
 * terminals, the window, or PasswdManager itself.
 */
export class AutoLock implements vscode.Disposable {
  private lastActivity = Date.now();
  private readonly interval: NodeJS.Timeout;
  private blurTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly hasUnlocked: () => boolean, private readonly lockAll: (reason: string) => Promise<void>) {
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

  private blurSuspendedUntil = 0;

  touch(): void {
    this.lastActivity = Date.now();
  }

  /** Temporarily ignores focus loss (e.g. while the user switches to the window showing a QR code). */
  suspendBlurLock(ms: number): void {
    this.blurSuspendedUntil = Date.now() + ms;
    this.touch();
  }

  private onWindowState(state: vscode.WindowState): void {
    if (state.focused) {
      this.touch();
      if (this.blurTimer) clearTimeout(this.blurTimer);
      this.blurTimer = undefined;
      return;
    }
    if (!config.lockOnWindowBlur() || !this.hasUnlocked() || Date.now() < this.blurSuspendedUntil) return;
    const grace = config.blurGraceSeconds();
    if (grace === 0) void this.lockAll('window lost focus');
    else this.blurTimer = setTimeout(() => void this.lockAll('window lost focus'), grace * 1000);
  }

  private async check(): Promise<void> {
    const minutes = config.autoLockMinutes();
    if (minutes <= 0 || !this.hasUnlocked()) return;
    if (Date.now() - this.lastActivity >= minutes * 60_000) {
      await this.lockAll(`inactive for ${minutes} min`);
    }
  }

  dispose(): void {
    clearInterval(this.interval);
    if (this.blurTimer) clearTimeout(this.blurTimer);
    for (const d of this.disposables) d.dispose();
  }
}
