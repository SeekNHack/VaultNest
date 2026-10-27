import { createHash, randomBytes } from 'node:crypto';
import * as kdbxweb from 'kdbxweb';
import type { HealthIssue, HealthReport } from '../../shared/model';
import { estimateStrength } from '../security/strength';

export interface HealthInput {
  id: string;
  password: kdbxweb.ProtectedValue | string;
  modified: number;
  expires: number | null;
  url: string;
  userInputs: string[];
}

export interface HealthOptions {
  maxAgeDays: number;
  now?: number;
}

/**
 * Score cache keyed by a salted hash of the password, so that re-computing the
 * report after each edit only analyses changed passwords. The salt is random
 * per process; hashes never leave memory.
 */
const SALT = randomBytes(32);
const scoreCache = new Map<string, number>();

function digest(value: string): string {
  return createHash('sha256').update(SALT).update(value, 'utf8').digest('base64');
}

export function analyzeHealth(vaultId: string, inputs: Iterable<HealthInput>, opts: HealthOptions): HealthReport {
  const now = opts.now ?? Date.now();
  const list = [...inputs];
  const hashes = new Map<string, string>();
  const groups = new Map<string, number>();
  const scores = new Map<string, number>();
  for (const it of list) {
    const text = typeof it.password === 'string' ? it.password : it.password.getText();
    const h = digest(text);
    hashes.set(it.id, h);
    groups.set(h, (groups.get(h) ?? 0) + 1);
    let score = scoreCache.get(h);
    if (score === undefined) {
      score = estimateStrength(text, it.userInputs).score;
      if (scoreCache.size > 10_000) scoreCache.clear();
      scoreCache.set(h, score);
    }
    scores.set(it.id, score);
  }
  const counts: Record<HealthIssue, number> = { weak: 0, reused: 0, old: 0, expired: 0, insecureUrl: 0 };
  const items: HealthReport['items'] = [];
  for (const it of list) {
    const issues: HealthIssue[] = [];
    const score = scores.get(it.id)!;
    const reusedCount = groups.get(hashes.get(it.id)!)!;
    if (score < 3) issues.push('weak');
    if (reusedCount > 1) issues.push('reused');
    if (opts.maxAgeDays > 0 && it.modified > 0 && now - it.modified > opts.maxAgeDays * 86_400_000) issues.push('old');
    if (it.expires !== null && it.expires < now) issues.push('expired');
    if (/^http:\/\//i.test(it.url.trim())) issues.push('insecureUrl');
    for (const i of issues) counts[i]++;
    if (issues.length) items.push({ id: it.id, issues, score, reusedCount: reusedCount > 1 ? reusedCount : undefined });
  }
  return { vaultId, generatedAt: now, total: list.length, counts, items };
}

/**
 * Scores passwords that are not cached yet, yielding to the event loop between
 * small batches so the extension host stays responsive on large vaults.
 * Afterwards {@link analyzeHealth} only hits the cache.
 */
export async function warmHealthCache(inputs: Iterable<HealthInput>, batch = 25): Promise<void> {
  let n = 0;
  for (const it of inputs) {
    const text = typeof it.password === 'string' ? it.password : it.password.getText();
    const h = digest(text);
    if (scoreCache.has(h)) continue;
    scoreCache.set(h, estimateStrength(text, it.userInputs).score);
    if (++n % batch === 0) await new Promise((r) => setImmediate(r));
  }
}

export function clearHealthCache(): void {
  scoreCache.clear();
}
