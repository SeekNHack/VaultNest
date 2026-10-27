import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { config } from '../config';

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Copies values to the system clipboard and clears sensitive ones after a
 * delay — but only if the clipboard still holds what we copied (we never wipe
 * something the user copied afterwards). Only a hash of the value is retained.
 */
export class ClipboardService implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private copiedHash: string | undefined;
  private statusMessage: vscode.Disposable | undefined;

  async copy(text: string, label: string, sensitive: boolean): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    this.cancelTimer();
    const seconds = config.clipboardClearSeconds();
    if (sensitive && seconds > 0) {
      this.copiedHash = hash(text);
      this.timer = setTimeout(() => void this.clearIfOurs(), seconds * 1000);
      this.flash(`$(check) ${label} copied — clipboard clears in ${seconds}s`);
    } else {
      this.copiedHash = sensitive ? hash(text) : undefined;
      this.flash(`$(check) ${label} copied`);
    }
  }

  /** Clears the clipboard if it still contains a secret we copied. */
  async clearIfOurs(): Promise<boolean> {
    this.cancelTimer();
    if (!this.copiedHash) return false;
    const expected = this.copiedHash;
    this.copiedHash = undefined;
    try {
      const current = await vscode.env.clipboard.readText();
      if (hash(current) === expected) {
        await vscode.env.clipboard.writeText('');
        this.flash('$(clear-all) Clipboard cleared');
        return true;
      }
    } catch {
      // clipboard not readable (e.g. remote/web environments): nothing we can safely do
    }
    return false;
  }

  async clearNow(): Promise<void> {
    this.cancelTimer();
    this.copiedHash = undefined;
    await vscode.env.clipboard.writeText('');
    this.flash('$(clear-all) Clipboard cleared');
  }

  private flash(text: string): void {
    this.statusMessage?.dispose();
    this.statusMessage = vscode.window.setStatusBarMessage(text, 4000);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.cancelTimer();
    this.statusMessage?.dispose();
  }
}
