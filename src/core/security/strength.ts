import { ZxcvbnFactory } from '@zxcvbn-ts/core';
// Only the clean word lists are bundled: the leaked-password list and the large English
// word lists (common words, Wikipedia, surnames) contain explicit words and are left out.
import adjacencyGraphs from '@zxcvbn-ts/language-common/dist/adjacencyGraphs.json.mjs';
import diceware from '@zxcvbn-ts/language-common/dist/diceware.json.mjs';
import firstnames from '@zxcvbn-ts/language-en/dist/firstnames.json.mjs';
import translations from '@zxcvbn-ts/language-en/dist/translations.mjs';
import wordSequences from '@zxcvbn-ts/language-en/dist/wordSequences.json.mjs';
import type { StrengthResult } from '../../shared/model';

export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** zxcvbn becomes slow on very long inputs; the tail adds no useful signal. */
const MAX_ANALYZED_LENGTH = 100;

let factory: ZxcvbnFactory | undefined;
function engine(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    dictionary: { 'diceware-common': diceware, 'firstnames-en': firstnames, ...wordSequences },
    graphs: adjacencyGraphs,
    translations,
  });
  return factory;
}

/**
 * Estimates the strength of a password with zxcvbn (realistic attacker model:
 * word lists, keyboard patterns, sequences, repeats, dates, l33t...).
 */
export function estimateStrength(value: string, userInputs: string[] = [], entropyBits?: number): StrengthResult {
  if (!value) {
    return { score: 0, label: STRENGTH_LABELS[0], guessesLog10: 0, crackTime: 'instant', warning: '', suggestions: [] };
  }
  const r = engine().check(value.slice(0, MAX_ANALYZED_LENGTH), userInputs.filter(Boolean).slice(0, 10));
  let score = r.score as StrengthResult['score'];
  // Long random values (>= 100 bits from our CSPRNG generator) are strong even if zxcvbn is conservative.
  if (entropyBits !== undefined && entropyBits >= 75 && score < 4) score = 4;
  return {
    score,
    label: STRENGTH_LABELS[score],
    guessesLog10: Math.round(r.guessesLog10 * 10) / 10,
    crackTime: r.crackTimes.offlineSlowHashingXPerSecond.display,
    warning: r.feedback.warning ?? '',
    suggestions: r.feedback.suggestions ?? [],
    entropyBits,
  };
}
