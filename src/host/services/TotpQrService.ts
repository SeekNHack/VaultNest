import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { MAX_IMAGE_BYTES } from '../../core/security/qr';
import { parseOtpPayload, TotpError, type OtpAccount, type OtpPayload } from '../../core/security/totp';
import { scanImagesForQr } from './qrScanner';
import { captureScreens, CaptureUnavailableError } from './screenCapture';

export type QrSource = 'screen' | 'file';

const COUNTDOWN_SECONDS = 5;

/**
 * Reads two-factor (TOTP) keys from QR codes: on the screen, in an image file or
 * in a pasted image. Everything happens locally: screenshots and images are only
 * held in memory (or in a private temporary folder that is deleted immediately)
 * and are never logged, stored or sent anywhere.
 */
export class TotpQrService {
  /** Overridable by tests. */
  countdownSeconds = COUNTDOWN_SECONDS;

  constructor(private readonly extensionPath: string, private readonly suspendBlurLock: (ms: number) => void) {}

  /** Asks where to read the QR code from. */
  async pickSource(): Promise<QrSource | undefined> {
    const pick = await vscode.window.showQuickPick([
      { label: '$(device-desktop) Scan the screen', detail: `Show the QR code (e.g. in your browser), then wait ${this.countdownSeconds} seconds`, source: 'screen' as const },
      { label: '$(file-media) Choose an image file…', detail: 'A screenshot or saved image of the QR code (PNG or JPEG)', source: 'file' as const },
    ], { title: 'Read a 2FA QR code' });
    return pick?.source;
  }

  /**
   * Scans and parses a QR code. Returns undefined when the user cancelled or
   * nothing usable was found (the user has already been told why).
   */
  async scan(source: QrSource | Uint8Array): Promise<OtpPayload | undefined> {
    let images: Uint8Array[] | undefined;
    if (source === 'screen') images = await this.captureWithCountdown();
    else if (source === 'file') images = await this.readImageFile();
    else images = [source];
    if (!images) return undefined;

    let text: string | null;
    try {
      text = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'PasswdManager: looking for a QR code…' },
        () => scanImagesForQr(this.extensionPath, images),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`PasswdManager: ${(err as Error).message}`);
      return undefined;
    }
    if (!text) {
      await this.notFound(source);
      return undefined;
    }
    let payload: OtpPayload;
    try {
      payload = parseOtpPayload(text);
    } catch (err) {
      const msg = err instanceof TotpError ? err.message : `The QR code is not a valid authenticator key (${(err as Error).message}).`;
      void vscode.window.showErrorMessage(`PasswdManager: ${msg}`);
      return undefined;
    }
    if (!payload.accounts.length) {
      void vscode.window.showWarningMessage('PasswdManager: the QR code contains no time-based (TOTP) account that can be imported.');
      return undefined;
    }
    if (payload.skipped) {
      void vscode.window.showWarningMessage(`PasswdManager: ${payload.skipped} account(s) in the QR code were skipped (counter-based HOTP or unsupported algorithm).`);
    }
    return payload;
  }

  /** Scans and returns a single account (asking which one if the QR code holds several). */
  async scanOne(source: QrSource | Uint8Array): Promise<OtpAccount | undefined> {
    const payload = await this.scan(source);
    if (!payload) return undefined;
    if (payload.accounts.length === 1) return payload.accounts[0];
    const pick = await vscode.window.showQuickPick(payload.accounts.map((a) => ({ label: accountLabel(a), description: a.issuer ? a.account : undefined, account: a })), {
      title: `This QR code contains ${payload.accounts.length} accounts — choose one`,
    });
    return pick?.account;
  }

  private async captureWithCountdown(): Promise<Uint8Array[] | undefined> {
    // The user is expected to switch to another window: do not lock on focus loss meanwhile.
    this.suspendBlurLock((this.countdownSeconds + 30) * 1000);
    const go = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'PasswdManager: capturing the screen', cancellable: true },
      async (progress, token) => {
        for (let s = this.countdownSeconds; s > 0; s--) {
          progress.report({ message: `make the QR code visible… ${s}` });
          await new Promise((r) => setTimeout(r, 1000));
          if (token.isCancellationRequested) return false;
        }
        progress.report({ message: 'capturing…' });
        return true;
      },
    );
    if (!go) return undefined;
    try {
      return await captureScreens();
    } catch (err) {
      const fileOption = 'Choose Image File…';
      const message = err instanceof CaptureUnavailableError
        ? err.message
        : `The screen could not be captured (${(err as Error).message}). You can save the QR code as an image, or paste it into the authenticator key field of the item editor.`;
      if ((await vscode.window.showErrorMessage(`PasswdManager: ${message}`, fileOption)) === fileOption) return this.readImageFile();
      return undefined;
    }
  }

  private async readImageFile(): Promise<Uint8Array[] | undefined> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Choose an image containing the QR code', canSelectMany: false, openLabel: 'Scan',
      filters: { Images: ['png', 'jpg', 'jpeg'] },
    });
    if (!uris?.length) return undefined;
    const file = uris[0].fsPath;
    const stat = await fs.stat(file);
    if (stat.size > MAX_IMAGE_BYTES) {
      void vscode.window.showErrorMessage('PasswdManager: the image is too large.');
      return undefined;
    }
    return [new Uint8Array(await fs.readFile(file))];
  }

  private async notFound(source: QrSource | Uint8Array): Promise<void> {
    const tips = ['Make sure the whole QR code is visible and not too small (zoom in if needed).'];
    if (source === 'screen' && process.platform === 'darwin') {
      tips.push('On macOS, VS Code needs the Screen Recording permission (System Settings › Privacy & Security › Screen Recording).');
    }
    if (source === 'screen') tips.push('Alternatively, copy the QR image and paste it into the authenticator key field of the item editor, or type the setup key shown below the QR code.');
    else tips.push('If the website shows a text "setup key", you can type it in the authenticator key field instead.');
    void vscode.window.showWarningMessage(`PasswdManager: no QR code found. ${tips.join(' ')}`);
  }
}

export function accountLabel(a: OtpAccount): string {
  return a.issuer || a.account || 'Account';
}
