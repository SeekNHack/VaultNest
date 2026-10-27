import { describe, expect, it } from 'vitest';
import { base32Decode, normalizeTotpInput, parseKeePassNativeTotp, parseTotp, totpCode, TotpError } from '../../src/core/security/totp';

// RFC 6238 Appendix B test vectors.
const SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
const SHA256_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';

describe('TOTP', () => {
  it('matches RFC 6238 vectors (SHA1)', () => {
    const p = parseTotp(`otpauth://totp/x?secret=${SHA1_SECRET}&digits=8`);
    expect(totpCode(p, 59_000).code).toBe('94287082');
    expect(totpCode(p, 1111111109_000).code).toBe('07081804');
    expect(totpCode(p, 20000000000_000).code).toBe('65353130');
  });

  it('matches RFC 6238 vectors (SHA256)', () => {
    const p = parseTotp(`otpauth://totp/x?secret=${SHA256_SECRET}&digits=8&algorithm=SHA256`);
    expect(totpCode(p, 59_000).code).toBe('46119246');
  });

  it('computes remaining seconds', () => {
    const p = parseTotp(SHA1_SECRET);
    expect(totpCode(p, 10_000).remaining).toBe(20);
  });

  it('decodes base32 with spaces and padding', () => {
    expect(Buffer.from(base32Decode('mzxw 6ytb oi======')).toString()).toBe('foobar');
    expect(() => base32Decode('not base32!')).toThrow(TotpError);
  });

  it('rejects HOTP and bad parameters', () => {
    expect(() => parseTotp('otpauth://hotp/x?secret=ABC&counter=1')).toThrow(TotpError);
    expect(() => parseTotp(`otpauth://totp/x?secret=${SHA1_SECRET}&digits=99`)).toThrow(TotpError);
  });

  it('wraps bare secrets into otpauth URIs', () => {
    const uri = normalizeTotpInput('jbsw y3dp ehpk 3pxp', 'My Site');
    expect(uri).toBe('otpauth://totp/My%20Site?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1');
  });

  it('reads KeePass 2.x native TOTP fields', () => {
    const p = parseKeePassNativeTotp(new Map([['TimeOtp-Secret-Base32', SHA1_SECRET], ['TimeOtp-Length', '8']]));
    expect(totpCode(p!, 59_000).code).toBe('94287082');
  });
});
