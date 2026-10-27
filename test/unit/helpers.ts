import * as kdbxweb from 'kdbxweb';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import type { EntryInput } from '../../src/shared/model';
import type { KdfSettings } from '../../src/core/vault/VaultDocument';
import type { SessionHooks } from '../../src/core/vault/VaultSession';

/** Cheap KDF for fast tests (production defaults are much stronger). */
export const FAST_KDF: KdfSettings = { memoryMiB: 1, iterations: 1, parallelism: 1 };

export const pv = (s: string) => kdbxweb.ProtectedValue.fromString(s);

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'vaultnest-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

export function entryInput(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    type: 'login', title: 'GitHub', username: 'octocat', password: 'S3cure!pass', url: 'https://github.com',
    notes: '', tags: [], favorite: false, folderId: null, expires: null, totp: '', customFields: [],
    ...overrides,
  };
}

export function hooks(backupDir: string, overrides: Partial<SessionHooks> = {}): SessionHooks {
  return {
    backupOptions: () => ({ enabled: true, directory: backupDir, keep: 3, intervalMs: 0 }),
    resolveConflict: async () => 'cancel',
    ...overrides,
  };
}
