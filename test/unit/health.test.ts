import { describe, expect, it } from 'vitest';
import { analyzeHealth, warmHealthCache } from '../../src/core/health/health';
import { estimateStrength } from '../../src/core/security/strength';
import { pv } from './helpers';

describe('strength', () => {
  it('scores by length and character variety', () => {
    expect(estimateStrength('')).toEqual({ score: 0, label: 'Very weak', entropyBits: 0 });
    expect(estimateStrength('abcdef')).toMatchObject({ score: 0, entropyBits: 28 }); // 6 × log2(26)
    expect(estimateStrength('password1')).toMatchObject({ score: 1, entropyBits: 47 }); // 9 × log2(36)
    expect(estimateStrength('Summer2024!')).toMatchObject({ score: 3, entropyBits: 72 }); // 11 × log2(95)
    expect(estimateStrength('xK#9v!Qm2$Lp7@Wz').score).toBe(4); // 16 × log2(95) ≈ 105 bits
    expect(estimateStrength('pässwörd').entropyBits).toBe(Math.round(8 * Math.log2(126)));
  });

  it('uses the generator entropy when it is known', () => {
    expect(estimateStrength('abc', 90)).toMatchObject({ score: 4, entropyBits: 90 });
  });
});

describe('health report', () => {
  const now = Date.UTC(2026, 0, 1);
  it('detects weak, reused, old, expired and insecure entries', () => {
    const r = analyzeHealth('v', [
      { id: 'a', password: pv('password'), modified: now, expires: null, url: 'https://a' },
      { id: 'b', password: 'password', modified: now - 400 * 86_400_000, expires: now - 1, url: 'http://b' },
      { id: 'c', password: pv('Zr8#u2!LqW9@vNx4'), modified: now, expires: null, url: '' },
    ], { maxAgeDays: 365, now });
    expect(r.total).toBe(3);
    expect(r.counts).toEqual({ weak: 2, reused: 2, old: 1, expired: 1, insecureUrl: 1 });
    expect(r.items.find((i) => i.id === 'b')!.issues.sort()).toEqual(['expired', 'insecureUrl', 'old', 'reused', 'weak']);
    expect(r.items.find((i) => i.id === 'c')).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('password"');
  });
});

describe('warmHealthCache', () => {
  it('pre-computes scores so the report is consistent', async () => {
    const inputs = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, password: `pw-${i}-qwerty`, modified: 0, expires: null, url: '' }));
    await warmHealthCache(inputs, 10);
    const r = analyzeHealth('v', inputs, { maxAgeDays: 0 });
    expect(r.total).toBe(60);
    expect(r.counts.reused).toBe(0);
  });
});
