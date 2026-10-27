import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { decodeImage, QrError, scanQrInImage } from '../../src/core/security/qr';
import { base32Decode, base32Encode, parseOtpPayload, parseTotp, totpCode, TotpError } from '../../src/core/security/totp';

const URI = 'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&period=30&digits=6&algorithm=SHA1';

async function qrPng(text: string, scale = 4): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', scale, margin: 2 });
}

/** Pastes a QR code into a large noisy "screenshot". */
async function fakeScreenshot(text: string, width = 2560, height = 1440): Promise<{ data: Buffer; width: number; height: number }> {
  const qr = PNG.sync.read(await qrPng(text, 5));
  const shot = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // light background with dense "text lines", like a web page
      const v = y % 18 < 12 && (x * 13 + y * 7) % 11 < 4 ? 40 : 235;
      const i = (y * width + x) * 4;
      shot.data[i] = v; shot.data[i + 1] = v; shot.data[i + 2] = v; shot.data[i + 3] = 255;
    }
  }
  const ox = 1700;
  const oy = 600;
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const s = (y * qr.width + x) * 4;
      const d = ((oy + y) * width + ox + x) * 4;
      shot.data[d] = qr.data[s]; shot.data[d + 1] = qr.data[s + 1]; shot.data[d + 2] = qr.data[s + 2]; shot.data[d + 3] = 255;
    }
  }
  return { data: shot.data, width, height };
}

/** Minimal protobuf writer used to build a Google Authenticator export. */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const fieldBytes = (f: number, b: Uint8Array | number[]) => [...varint((f << 3) | 2), ...varint(b.length), ...b];
const fieldVarint = (f: number, v: number) => [...varint(f << 3), ...varint(v)];
function otpParams(secret: Uint8Array, name: string, issuer: string, algo: number, digits: number, type: number): number[] {
  return [...fieldBytes(1, secret), ...fieldBytes(2, [...Buffer.from(name)]), ...fieldBytes(3, [...Buffer.from(issuer)]),
    ...fieldVarint(4, algo), ...fieldVarint(5, digits), ...fieldVarint(6, type)];
}

describe('QR decoding', () => {
  it('decodes a PNG QR code', async () => {
    expect(scanQrInImage(await qrPng(URI))).toBe(URI);
  });

  it('finds a QR code inside a large screenshot', async () => {
    const shot = await fakeScreenshot(URI);
    const png = new PNG({ width: shot.width, height: shot.height });
    shot.data.copy(png.data);
    expect(scanQrInImage(PNG.sync.write(png))).toBe(URI);
  });

  it('decodes JPEG images', async () => {
    const qr = PNG.sync.read(await qrPng(URI, 6));
    const jpg = jpeg.encode({ data: qr.data, width: qr.width, height: qr.height }, 90).data;
    expect(scanQrInImage(jpg)).toBe(URI);
  });

  it('returns null when there is no QR code and rejects other formats', async () => {
    const blank = new PNG({ width: 300, height: 300 });
    blank.data.fill(255);
    expect(scanQrInImage(PNG.sync.write(blank))).toBeNull();
    expect(() => decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(QrError);
  });

  it('rejects oversized images before decoding them', () => {
    const header = Buffer.from(PNG.sync.write(new PNG({ width: 1, height: 1 })));
    header.writeUInt32BE(100000, 16);
    header.writeUInt32BE(100000, 20);
    expect(() => decodeImage(header)).toThrow(/too large/);
  });
});

describe('2FA payloads', () => {
  it('parses otpauth TOTP URIs with issuer and account', () => {
    const p = parseOtpPayload(URI);
    expect(p.accounts).toEqual([{ uri: URI, issuer: 'GitHub', account: 'octocat' }]);
  });

  it('rejects HOTP and non-2FA QR codes', () => {
    expect(() => parseOtpPayload('otpauth://hotp/x?secret=JBSWY3DP&counter=1')).toThrow(/HOTP/);
    expect(() => parseOtpPayload('https://example.com')).toThrow(TotpError);
    expect(() => parseOtpPayload('otpauth://totp/x?secret=!!!')).toThrow(TotpError);
  });

  it('round-trips base32', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 7, 99, 42, 13, 200, 1]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('imports Google Authenticator export payloads (several accounts, HOTP skipped)', async () => {
    const s1 = Uint8Array.from(Buffer.from('12345678901234567890'));
    const s2 = Uint8Array.from(Buffer.from('abcdefghijabcdefghij'));
    const payload = Uint8Array.from([
      ...fieldBytes(1, otpParams(s1, 'alice@example.com', 'Google', 1, 1, 2)),
      ...fieldBytes(1, otpParams(s2, 'GitLab:bob', '', 2, 2, 2)),
      ...fieldBytes(1, otpParams(s1, 'counter', 'Old', 1, 1, 1)), // HOTP
      ...fieldVarint(2, 1), ...fieldVarint(3, 1), ...fieldVarint(4, 0),
    ]);
    const uri = `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(payload).toString('base64'))}`;
    // Also make sure it survives a real QR encode/decode round trip.
    const scanned = scanQrInImage(await qrPng(uri));
    const { accounts, skipped } = parseOtpPayload(scanned!);
    expect(skipped).toBe(1);
    expect(accounts.map((a) => [a.issuer, a.account])).toEqual([['Google', 'alice@example.com'], ['GitLab', 'bob']]);
    const p1 = parseTotp(accounts[0].uri);
    expect(totpCode({ ...p1, digits: 8 }, 59_000).code).toBe('94287082'); // RFC 6238 vector with the same secret
    const p2 = parseTotp(accounts[1].uri);
    expect(p2.algorithm).toBe('SHA256');
    expect(p2.digits).toBe(8);
  });
});
