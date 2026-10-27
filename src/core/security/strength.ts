import type { StrengthResult } from '../../shared/model';

export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** Lower bounds, in bits, of scores 1..4. */
const SCORE_BITS = [36, 50, 64, 80];

const CHARACTER_SETS: [RegExp, number][] = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/, 33], // ASCII symbols and space
  [/[^\x00-\x7f]/, 100], // anything outside ASCII
];

/**
 * Estimates complexity as length × log2(size of the character sets used).
 * It does not look for words or patterns. For generated values the generator's
 * own entropy is used instead.
 */
export function estimateStrength(value: string, entropyBits?: number): StrengthResult {
  const length = [...value].length;
  const pool = CHARACTER_SETS.reduce((n, [re, size]) => (re.test(value) ? n + size : n), 0);
  const bits = entropyBits ?? (length && pool ? Math.round(length * Math.log2(pool)) : 0);
  const score = SCORE_BITS.filter((b) => bits >= b).length as StrengthResult['score'];
  return { score, label: STRENGTH_LABELS[score], entropyBits: bits };
}
