/**
 * Worker thread that decodes screenshots / images and looks for a QR code.
 * Image decoding of untrusted input runs here so that slow or malicious images
 * can never block (or crash) the extension host; the host enforces a timeout.
 */
import { parentPort } from 'node:worker_threads';
import { scanQrInImage } from '../../core/security/qr';

parentPort?.on('message', (images: Uint8Array[]) => {
  try {
    for (const img of images) {
      const text = scanQrInImage(img);
      if (text) {
        parentPort!.postMessage({ ok: true, text });
        return;
      }
    }
    parentPort!.postMessage({ ok: true, text: null });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
