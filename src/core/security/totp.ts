import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP support, compatible with the KeePassXC convention of storing an
 * `otpauth://totp/...` URI in an entry field named `otp`, and with KeePass 2.x
 * native `TimeOtp-*` fields.
 */
export interface TotpParams {
  secret: Uint8Array;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
}

export class TotpError extends Error {}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new TotpError('Invalid base32 secret');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function normAlgo(a: string | null | undefined): TotpParams['algorithm'] {
  const v = (a ?? 'SHA1').toUpperCase().replace('-', '').replace('HMAC', '');
  if (v === 'SHA1' || v === 'SHA256' || v === 'SHA512') return v;
  throw new TotpError(`Unsupported TOTP algorithm: ${a}`);
}

function intParam(v: string | null | undefined, def: number, min: number, max: number): number {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new TotpError('Invalid TOTP parameter');
  return n;
}

/** Parses an otpauth:// URI or a bare base32 secret. */
export function parseTotp(value: string): TotpParams {
  const text = value.trim();
  if (/^otpauth:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== 'totp') throw new TotpError('Only TOTP (time-based) codes are supported');
    const secret = url.searchParams.get('secret');
    if (!secret) throw new TotpError('Missing TOTP secret');
    return {
      secret: base32Decode(secret),
      algorithm: normAlgo(url.searchParams.get('algorithm')),
      digits: intParam(url.searchParams.get('digits'), 6, 6, 10),
      period: intParam(url.searchParams.get('period'), 30, 1, 3600),
    };
  }
  return { secret: base32Decode(text), algorithm: 'SHA1', digits: 6, period: 30 };
}

/** Builds TOTP params from KeePass 2.x native fields (TimeOtp-Secret-Base32, ...). */
export function parseKeePassNativeTotp(fields: Map<string, string>): TotpParams | undefined {
  const b32 = fields.get('TimeOtp-Secret-Base32');
  const hex = fields.get('TimeOtp-Secret-Hex');
  const b64 = fields.get('TimeOtp-Secret-Base64');
  const utf8 = fields.get('TimeOtp-Secret');
  let secret: Uint8Array | undefined;
  if (b32) secret = base32Decode(b32);
  else if (hex) secret = Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'));
  else if (b64) secret = Uint8Array.from(Buffer.from(b64, 'base64'));
  else if (utf8) secret = Uint8Array.from(Buffer.from(utf8, 'utf8'));
  if (!secret || secret.length === 0) return undefined;
  return {
    secret,
    algorithm: normAlgo(fields.get('TimeOtp-Algorithm')),
    digits: intParam(fields.get('TimeOtp-Length'), 6, 6, 10),
    period: intParam(fields.get('TimeOtp-Period'), 30, 1, 3600),
  };
}

export function totpCode(params: TotpParams, nowMs: number = Date.now()): { code: string; remaining: number; period: number } {
  const counter = Math.floor(nowMs / 1000 / params.period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(params.algorithm.toLowerCase(), Buffer.from(params.secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const code = (bin % 10 ** params.digits).toString().padStart(params.digits, '0');
  const remaining = params.period - (Math.floor(nowMs / 1000) % params.period);
  return { code, remaining, period: params.period };
}

/** Normalises user input to an otpauth URI (bare secrets are wrapped). */
export function normalizeTotpInput(value: string, label: string): string {
  const text = value.trim();
  if (!text) return '';
  parseTotp(text); // throws on invalid input
  if (/^otpauth:\/\//i.test(text)) return text;
  const secret = text.toUpperCase().replace(/[\s=-]/g, '');
  return `otpauth://totp/${encodeURIComponent(label || 'PasswdVault')}?secret=${secret}&period=30&digits=6&algorithm=SHA1`;
}
