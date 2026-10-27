import jsQR from 'jsqr';
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/** Decoded RGBA pixels. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export class QrError extends Error {}

/** Refuse absurdly large images (decompression bombs). 8K × 8K is plenty for multi-monitor screenshots. */
const MAX_PIXELS = 8192 * 8192;
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Decodes a PNG or JPEG file into RGBA pixels (pure JavaScript, no native code). */
export function decodeImage(bytes: Uint8Array): RgbaImage {
  if (bytes.length > MAX_IMAGE_BYTES) throw new QrError('The image is too large.');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) {
    // Check dimensions from the IHDR chunk before inflating.
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w * h > MAX_PIXELS) throw new QrError('The image is too large.');
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height };
  }
  if (isJpeg(bytes)) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 1024 });
    return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
  }
  throw new QrError('Unsupported image format (use PNG or JPEG).');
}

/** Halves the resolution (box filter) — helps with noisy HiDPI screenshots and speeds up scanning. */
function downscale(img: RgbaImage): RgbaImage {
  const width = Math.floor(img.width / 2);
  const height = Math.floor(img.height / 2);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const i = ((y * 2) * img.width + x * 2) * 4 + c;
        const j = i + img.width * 4;
        data[(y * width + x) * 4 + c] = (img.data[i] + img.data[i + 4] + img.data[j] + img.data[j + 4]) >> 2;
      }
    }
  }
  return { data, width, height };
}

/** Finds a QR code in the image and returns its text content, or null. */
export function scanQr(img: RgbaImage): string | null {
  const attempt = (i: RgbaImage) => jsQR(i.data, i.width, i.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  let found = attempt(img);
  let current = img;
  while (!found && current.width > 600 && current.height > 600) {
    current = downscale(current);
    found = attempt(current);
  }
  return found;
}

export function scanQrInImage(bytes: Uint8Array): string | null {
  return scanQr(decodeImage(bytes));
}
