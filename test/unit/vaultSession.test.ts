import { promises as fs, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VaultSession, SaveCancelledError } from '../../src/core/vault/VaultSession';
import { listBackups, looksLikeKdbx } from '../../src/core/vault/VaultStorage';
import { entryInput, FAST_KDF, hooks, pv, tempDir } from './helpers';

async function setup() {
  const dir = tempDir();
  const file = path.join(dir, 'vault.kdbx');
  const backups = path.join(dir, 'backups');
  const session = await VaultSession.create(file, 'Test', { password: pv('master') }, FAST_KDF, hooks(backups));
  return { dir, file, backups, session };
}

describe('VaultSession', () => {
  it('creates an encrypted vault file with private permissions', async () => {
    const { file } = await setup();
    const bytes = await fs.readFile(file);
    expect(looksLikeKdbx(bytes)).toBe(true);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing file on create', async () => {
    const { file, backups } = await setup();
    await expect(VaultSession.create(file, 'X', { password: pv('a') }, FAST_KDF, hooks(backups))).rejects.toThrow(/already exists/);
  });

  it('persists mutations, leaves no temp files and unlocks again', async () => {
    const { dir, file, backups, session } = await setup();
    const id = await session.mutate((d) => d.saveEntry(null, entryInput()));
    expect(session.dirty).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await session.lock();
    expect(session.unlocked).toBe(false);
    expect(() => session.doc).toThrow(/locked/);
    const again = new VaultSession(file, hooks(backups));
    await expect(again.unlock({ password: pv('wrong') })).rejects.toBeTruthy();
    await again.unlock({ password: pv('master') });
    expect(again.doc.revealField(id, 'Password')).toBe('S3cure!pass');
  });

  it('rotates backups', async () => {
    const { file, backups, session } = await setup();
    for (let i = 0; i < 6; i++) {
      await session.mutate((d) => d.saveEntry(null, entryInput({ title: `E${i}` })));
      await new Promise((r) => setTimeout(r, 3));
    }
    const list = await listBackups(file, backups);
    expect(list).toHaveLength(3);
    for (const b of list) expect(looksLikeKdbx(await fs.readFile(b))).toBe(true);
  });

  it('merges changes written to the file by another client before saving', async () => {
    const { file, backups, session } = await setup();
    const other = new VaultSession(file, hooks(backups));
    await other.unlock({ password: pv('master') });
    await other.mutate((d) => d.saveEntry(null, entryInput({ title: 'From KeePassXC' })));
    await session.mutate((d) => d.saveEntry(null, entryInput({ title: 'From VS Code' })));
    const check = new VaultSession(file, hooks(backups));
    await check.unlock({ password: pv('master') });
    expect(check.doc.listEntries().map((e) => e.title).sort()).toEqual(['From KeePassXC', 'From VS Code']);
  });

  it('syncFromDisk pulls external changes', async () => {
    const { file, backups, session } = await setup();
    expect(await session.syncFromDisk()).toBe(false);
    const other = new VaultSession(file, hooks(backups));
    await other.unlock({ password: pv('master') });
    await other.mutate((d) => d.saveEntry(null, entryInput({ title: 'Remote' })));
    expect(await session.syncFromDisk()).toBe(true);
    expect(session.doc.listEntries().map((e) => e.title)).toEqual(['Remote']);
  });

  it('asks before overwriting a file whose master password changed elsewhere', async () => {
    const { file, backups, session } = await setup();
    const other = new VaultSession(file, hooks(backups));
    await other.unlock({ password: pv('master') });
    await other.mutate((d) => d.changeCredentials({ password: pv('changed') }, FAST_KDF));
    await expect(session.mutate((d) => d.saveEntry(null, entryInput()))).rejects.toBeInstanceOf(SaveCancelledError);
    expect(session.dirty).toBe(true);

    const overwrite = new VaultSession(file, hooks(backups, { resolveConflict: async () => 'overwrite' }));
    // unlock with the new password, then simulate the opposite conflict
    await overwrite.unlock({ password: pv('changed') });
    await overwrite.mutate((d) => d.saveEntry(null, entryInput({ title: 'ok' })));
    expect(overwrite.doc.listEntries()).toHaveLength(1);
  });

  it('asks before recreating a deleted vault file', async () => {
    const { file, session } = await setup();
    await fs.rm(file);
    await expect(session.mutate((d) => d.saveEntry(null, entryInput()))).rejects.toBeInstanceOf(SaveCancelledError);
  });

  it('writes an encrypted recovery copy when locking with unsaved changes', async () => {
    const { file, backups, session } = await setup();
    await fs.rm(file);
    await session.mutate((d) => d.saveEntry(null, entryInput())).catch(() => undefined);
    const recovery = await session.lock();
    expect(recovery).toMatch(/recovered/);
    const r = new VaultSession(recovery!, hooks(backups));
    await r.unlock({ password: pv('master') });
    expect(r.doc.listEntries()).toHaveLength(1);
  });

  it('serialises concurrent saves', async () => {
    const { file, backups, session } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => session.mutate((d) => d.saveEntry(null, entryInput({ title: `P${i}` })))));
    const check = new VaultSession(file, hooks(backups));
    await check.unlock({ password: pv('master') });
    expect(check.doc.listEntries()).toHaveLength(10);
  });
});
