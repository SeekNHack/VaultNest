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

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
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
  return `otpauth://totp/${encodeURIComponent(label || 'PasswdManager')}?secret=${secret}&period=30&digits=6&algorithm=SHA1`;
}

/** A 2FA account found in a QR code. */
export interface OtpAccount {
  /** Normalised otpauth://totp URI, ready to be stored. */
  uri: string;
  issuer: string;
  account: string;
}

export interface OtpPayload {
  accounts: OtpAccount[];
  /** Accounts that were present but cannot be used (e.g. counter-based HOTP). */
  skipped: number;
}

function buildUri(secret: Uint8Array, issuer: string, account: string, algorithm: TotpParams['algorithm'], digits: number, period: number): string {
  const label = issuer ? `${issuer}:${account}` : account || 'Account';
  const q = new URLSearchParams({ secret: base32Encode(secret), period: String(period), digits: String(digits), algorithm });
  if (issuer) q.set('issuer', issuer);
  return `otpauth://totp/${encodeURIComponent(label)}?${q.toString()}`;
}

/** Splits an otpauth label "Issuer:account" and the issuer parameter. */
function labelParts(url: URL): { issuer: string; account: string } {
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const idx = label.indexOf(':');
  const fromLabel = idx >= 0 ? label.slice(0, idx).trim() : '';
  const account = (idx >= 0 ? label.slice(idx + 1) : label).trim();
  return { issuer: url.searchParams.get('issuer')?.trim() || fromLabel, account };
}

// ---- Google Authenticator export (otpauth-migration://offline?data=<protobuf>) ----

interface ProtoField { field: number; wire: number; value: bigint | Uint8Array }

function* readProto(buf: Uint8Array): Generator<ProtoField> {
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new TotpError('Malformed migration payload');
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new TotpError('Malformed migration payload');
    }
  };
  while (pos < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) yield { field, wire, value: varint() };
    else if (wire === 2) {
      const len = Number(varint());
      if (pos + len > buf.length) throw new TotpError('Malformed migration payload');
      yield { field, wire, value: buf.subarray(pos, pos + len) };
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new TotpError('Malformed migration payload');
  }
}

const MIGRATION_ALGOS: Record<number, TotpParams['algorithm'] | undefined> = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };

export function parseMigrationPayload(uri: string): OtpPayload {
  const url = new URL(uri);
  // URLSearchParams turns '+' into ' ' — restore it, base64 never contains spaces.
  const data = url.searchParams.get('data')?.replace(/ /g, '+');
  if (!data) throw new TotpError('The export QR code contains no data');
  const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
  const accounts: OtpAccount[] = [];
  let skipped = 0;
  const text = (v: bigint | Uint8Array) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');
  for (const f of readProto(bytes)) {
    if (f.field !== 1 || !(f.value instanceof Uint8Array)) continue;
    let secret: Uint8Array | undefined;
    let name = '';
    let issuer = '';
    let algo = 1;
    let digits = 1;
    let type = 2;
    for (const p of readProto(f.value)) {
      if (p.field === 1 && p.value instanceof Uint8Array) secret = Uint8Array.from(p.value);
      else if (p.field === 2) name = text(p.value);
      else if (p.field === 3) issuer = text(p.value);
      else if (p.field === 4 && typeof p.value === 'bigint') algo = Number(p.value);
      else if (p.field === 5 && typeof p.value === 'bigint') digits = Number(p.value);
      else if (p.field === 6 && typeof p.value === 'bigint') type = Number(p.value);
    }
    const algorithm = MIGRATION_ALGOS[algo];
    if (!secret?.length || type !== 2 || !algorithm) {
      skipped++; // HOTP (type 1), MD5, or empty secret
      continue;
    }
    // Names are often "Issuer:account"
    let account = name;
    const idx = name.indexOf(':');
    if (idx >= 0) {
      if (!issuer) issuer = name.slice(0, idx).trim();
      account = name.slice(idx + 1).trim();
    }
    accounts.push({ uri: buildUri(secret, issuer, account, algorithm, digits === 2 ? 8 : 6, 30), issuer, account });
  }
  return { accounts, skipped };
}

/** Interprets the text of a scanned QR code as one or more TOTP accounts. */
export function parseOtpPayload(text: string): OtpPayload {
  const t = text.trim();
  if (/^otpauth-migration:\/\//i.test(t)) return parseMigrationPayload(t);
  if (/^otpauth:\/\/hotp\//i.test(t)) throw new TotpError('This QR code contains a counter-based (HOTP) key, which is not supported. Only time-based (TOTP) codes are.');
  if (/^otpauth:\/\/totp\//i.test(t)) {
    parseTotp(t); // validates the secret and parameters
    const { issuer, account } = labelParts(new URL(t));
    return { accounts: [{ uri: t, issuer, account }], skipped: 0 };
  }
  throw new TotpError('This QR code does not contain a two-factor (TOTP) key.');
}
