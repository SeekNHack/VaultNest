import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

const TIMEOUT_MS = 30_000;

/**
 * Decodes images in a worker thread and returns the text of the first QR code found.
 * Image buffers are transferred (not copied) and are detached from this thread afterwards.
 */
export function scanImagesForQr(extensionPath: string, images: Uint8Array[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(extensionPath, 'dist', 'qrWorker.js'));
    const done = (fn: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('Scanning the image took too long.'))), TIMEOUT_MS);
    worker.once('message', (m: { ok: boolean; text?: string | null; error?: string }) =>
      done(() => (m.ok ? resolve(m.text ?? null) : reject(new Error(m.error ?? 'Could not read the image.')))));
    worker.once('error', (err) => done(() => reject(err)));
    const owned = images.map((i) => (i.byteOffset === 0 && i.byteLength === i.buffer.byteLength ? i : i.slice()));
    worker.postMessage(owned, owned.map((i) => i.buffer as ArrayBuffer));
  });
}
