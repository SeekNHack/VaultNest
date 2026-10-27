import type { GeneratorOptions } from '../../shared/model';
import { RandomIntFn, secureRandomInt, shuffle } from '../security/random';
import { EFF_WORDLIST } from './effWordlist';

export const CHARSETS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?/~',
} as const;

/** Characters that are easily confused with each other in many fonts. */
export const AMBIGUOUS = 'Il1O0o|`\'"';

export const LIMITS = {
  minLength: 4,
  maxLength: 128,
  minWords: 3,
  maxWords: 20,
  maxSeparatorLength: 3,
} as const;

export interface GeneratedSecret {
  value: string;
  /** Entropy of the generation process in bits (upper bound for the attacker). */
  entropyBits: number;
}

export class GeneratorError extends Error {}

/** Clamps and normalises user-provided options (never trusts the UI). */
export function normalizeOptions(opts: GeneratorOptions): GeneratorOptions {
  const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number.isFinite(v) ? v : min)));
  const o: GeneratorOptions = {
    ...opts,
    length: int(opts.length, LIMITS.minLength, LIMITS.maxLength),
    words: int(opts.words, LIMITS.minWords, LIMITS.maxWords),
    minDigits: int(opts.minDigits, 0, 32),
    minSymbols: int(opts.minSymbols, 0, 32),
    separator: [...(opts.separator ?? '')].slice(0, LIMITS.maxSeparatorLength).join(''),
  };
  if (!o.uppercase && !o.lowercase && !o.digits && !o.symbols) o.lowercase = true;
  return o;
}

function pool(chars: string, avoidAmbiguous: boolean): string {
  return avoidAmbiguous ? [...chars].filter((c) => !AMBIGUOUS.includes(c)).join('') : chars;
}

export function generatePassword(input: GeneratorOptions, rnd: RandomIntFn = secureRandomInt): GeneratedSecret {
  const o = normalizeOptions(input);
  const sets: { chars: string; min: number }[] = [];
  if (o.uppercase) sets.push({ chars: pool(CHARSETS.uppercase, o.avoidAmbiguous), min: 1 });
  if (o.lowercase) sets.push({ chars: pool(CHARSETS.lowercase, o.avoidAmbiguous), min: 1 });
  if (o.digits) sets.push({ chars: pool(CHARSETS.digits, o.avoidAmbiguous), min: Math.max(1, o.minDigits) });
  if (o.symbols) sets.push({ chars: pool(CHARSETS.symbols, o.avoidAmbiguous), min: Math.max(1, o.minSymbols) });

  const required = sets.reduce((n, s) => n + s.min, 0);
  if (required > o.length) {
    throw new GeneratorError(`Length ${o.length} is too short for the minimum character requirements (${required}).`);
  }
  const all = sets.map((s) => s.chars).join('');
  const chars: string[] = [];
  for (const set of sets) {
    for (let i = 0; i < set.min; i++) chars.push(set.chars[rnd(set.chars.length)]);
  }
  while (chars.length < o.length) chars.push(all[rnd(all.length)]);
  shuffle(chars, rnd);
  return { value: chars.join(''), entropyBits: Math.round(o.length * Math.log2(all.length)) };
}

export function generatePassphrase(input: GeneratorOptions, rnd: RandomIntFn = secureRandomInt, wordlist: readonly string[] = EFF_WORDLIST): GeneratedSecret {
  const o = normalizeOptions(input);
  const words: string[] = [];
  for (let i = 0; i < o.words; i++) {
    let w = wordlist[rnd(wordlist.length)];
    if (o.capitalize) w = w.charAt(0).toUpperCase() + w.slice(1);
    words.push(w);
  }
  let entropy = o.words * Math.log2(wordlist.length);
  if (o.includeNumber) {
    const idx = rnd(words.length);
    words[idx] = words[idx] + String(rnd(10));
    entropy += Math.log2(10) + Math.log2(words.length);
  }
  return { value: words.join(o.separator), entropyBits: Math.round(entropy) };
}

export function generate(options: GeneratorOptions, rnd: RandomIntFn = secureRandomInt): GeneratedSecret {
  return options.mode === 'passphrase' ? generatePassphrase(options, rnd) : generatePassword(options, rnd);
}
