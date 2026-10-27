import { describe, expect, it } from 'vitest';
import { AMBIGUOUS, CHARSETS, generate, generatePassphrase, generatePassword, GeneratorError, normalizeOptions } from '../../src/core/generator/passwordGenerator';
import { EFF_WORDLIST } from '../../src/core/generator/effWordlist';
import { DEFAULT_GENERATOR_OPTIONS as D } from '../../src/shared/model';

describe('password generator', () => {
  it('generates the requested length with all enabled classes', () => {
    for (let i = 0; i < 200; i++) {
      const { value } = generatePassword({ ...D, length: 12 });
      expect(value).toHaveLength(12);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[0-9]/);
      expect([...value].some((c) => CHARSETS.symbols.includes(c))).toBe(true);
    }
  });

  it('honours disabled classes and minimum counts', () => {
    for (let i = 0; i < 100; i++) {
      const { value } = generatePassword({ ...D, length: 16, symbols: false, uppercase: false, minDigits: 5 });
      expect(value).toMatch(/^[a-z0-9]{16}$/);
      expect(value.replace(/\D/g, '').length).toBeGreaterThanOrEqual(5);
    }
  });

  it('excludes ambiguous characters when requested', () => {
    const { value } = generatePassword({ ...D, length: 128, avoidAmbiguous: true });
    for (const c of AMBIGUOUS) expect(value).not.toContain(c);
  });

  it('rejects impossible constraints', () => {
    expect(() => generatePassword({ ...D, length: 5, minDigits: 4, minSymbols: 4 })).toThrow(GeneratorError);
  });

  it('clamps unsafe option values', () => {
    const o = normalizeOptions({ ...D, length: 100000, words: -3, separator: 'abcdef', uppercase: false, lowercase: false, digits: false, symbols: false });
    expect(o.length).toBe(128);
    expect(o.words).toBe(3);
    expect(o.separator).toBe('abc');
    expect(o.lowercase).toBe(true);
    expect(generatePassword({ ...D, length: NaN }).value).toHaveLength(4);
  });

  it('reports entropy', () => {
    const r = generatePassword({ ...D, length: 20 });
    expect(r.entropyBits).toBeGreaterThan(120);
  });

  it('is not trivially biased (chi-square sanity check)', () => {
    const counts = new Map<string, number>();
    const n = 2000;
    for (let i = 0; i < n; i++) {
      for (const c of generatePassword({ ...D, length: 32, uppercase: false, symbols: false, digits: false, minDigits: 0, minSymbols: 0 }).value) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const expected = (n * 32) / 26;
    let chi = 0;
    for (const c of CHARSETS.lowercase) chi += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    expect(chi).toBeLessThan(60); // df=25, p≈0.0001 threshold
  });
});

describe('passphrase generator', () => {
  it('uses words from the EFF list with separator and capitalisation', () => {
    const { value, entropyBits } = generatePassphrase({ ...D, mode: 'passphrase', words: 6, separator: '_', includeNumber: false });
    const words = value.split('_');
    expect(words).toHaveLength(6);
    for (const w of words) {
      expect(w[0]).toBe(w[0].toUpperCase());
      expect(EFF_WORDLIST).toContain(w.toLowerCase());
    }
    expect(entropyBits).toBe(Math.round(6 * Math.log2(7776)));
  });

  it('adds a digit when includeNumber is set', () => {
    const { value } = generate({ ...D, mode: 'passphrase', words: 4, includeNumber: true, capitalize: false });
    expect(value).toMatch(/\d/);
  });

  it('ships the complete EFF large wordlist', () => {
    expect(EFF_WORDLIST).toHaveLength(7776);
    expect(new Set(EFF_WORDLIST).size).toBe(7776);
  });
});
