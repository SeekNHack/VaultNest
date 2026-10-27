import { randomInt as nodeRandomInt } from 'node:crypto';

/**
 * Source of uniformly distributed integers in [0, max).
 * Production code uses Node's CSPRNG (`crypto.randomInt`, which performs
 * rejection sampling, so there is no modulo bias). Tests may inject a
 * deterministic implementation.
 */
export type RandomIntFn = (max: number) => number;

export const secureRandomInt: RandomIntFn = (max) => {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('max must be a positive integer');
  return max === 1 ? 0 : nodeRandomInt(max);
};

/** Fisher–Yates shuffle using the given random source (in place). */
export function shuffle<T>(items: T[], rnd: RandomIntFn = secureRandomInt): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
