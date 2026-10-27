import { describe, expect, it } from 'vitest';
import { analyzeHealth, warmHealthCache } from '../../src/core/health/health';
import { estimateStrength } from '../../src/core/security/strength';
import { pv } from './helpers';

describe('strength', () => {
  it('scores common passwords as weak and random ones as strong', () => {
    expect(estimateStrength('password1').score).toBeLessThan(2);
    expect(estimateStrength('xK#9v!Qm2$Lp7@Wz').score).toBe(4);
    expect(estimateStrength('').score).toBe(0);
    expect(estimateStrength('a'.repeat(5000)).score).toBeLessThan(2); // long inputs are truncated, no hang
  });
});

describe('health report', () => {
  const now = Date.UTC(2026, 0, 1);
  it('detects weak, reused, old, expired and insecure entries', () => {
    const r = analyzeHealth('v', [
      { id: 'a', password: pv('password'), modified: now, expires: null, url: 'https://a', userInputs: [] },
      { id: 'b', password: 'password', modified: now - 400 * 86_400_000, expires: now - 1, url: 'http://b', userInputs: [] },
      { id: 'c', password: pv('Zr8#u2!LqW9@vNx4'), modified: now, expires: null, url: '', userInputs: [] },
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
    const inputs = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, password: `pw-${i}-qwerty`, modified: 0, expires: null, url: '', userInputs: [] }));
    await warmHealthCache(inputs, 10);
    const r = analyzeHealth('v', inputs, { maxAgeDays: 0 });
    expect(r.total).toBe(60);
    expect(r.counts.reused).toBe(0);
  });
});
