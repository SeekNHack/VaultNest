import * as kdbxweb from 'kdbxweb';
import { describe, expect, it } from 'vitest';
import { CUSTOM_DATA, makeCredentials, VaultDocument, VaultError } from '../../src/core/vault/VaultDocument';
import { entryInput, FAST_KDF, pv } from './helpers';

async function newDoc(password = 'master') {
  return VaultDocument.create('Test', await makeCredentials({ password: pv(password) }), FAST_KDF);
}

async function roundtrip(doc: VaultDocument, password = 'master') {
  return VaultDocument.load(await doc.save(), await makeCredentials({ password: pv(password) }));
}

describe('VaultDocument', () => {
  it('creates KDBX 4 vaults with Argon2id and the requested parameters', async () => {
    const doc = await newDoc();
    const info = (await roundtrip(doc)).formatInfo;
    expect(info.kdbxVersion.startsWith('4.')).toBe(true);
    expect(info.kdf).toBe('Argon2id');
    expect(info.kdfMemoryMiB).toBe(1);
    expect(info.kdfIterations).toBe(1);
  });

  it('rejects a wrong master password', async () => {
    const doc = await newDoc('right');
    await expect(roundtrip(doc, 'wrong')).rejects.toMatchObject({ code: kdbxweb.Consts.ErrorCodes.InvalidKey });
  });

  it('supports key files in addition to the password', async () => {
    const keyFile = await kdbxweb.KdbxCredentials.createRandomKeyFile(2);
    const doc = VaultDocument.create('K', await makeCredentials({ password: pv('pw'), keyFile }), FAST_KDF);
    const bytes = await doc.save();
    await expect(VaultDocument.load(bytes, await makeCredentials({ password: pv('pw') }))).rejects.toBeTruthy();
    const ok = await VaultDocument.load(bytes, await makeCredentials({ password: pv('pw'), keyFile }));
    expect(ok.formatInfo.hasKeyFile).toBe(true);
  });

  it('creates, reads and persists entries with protected passwords', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput({ tags: ['work', ' work ', 'dev'], favorite: true, type: 'apiKey' }));
    const loaded = await roundtrip(doc);
    const d = loaded.getEntry(id);
    expect(d.title).toBe('GitHub');
    expect(d.username).toBe('octocat');
    expect(d.tags).toEqual(['work', 'dev']);
    expect(d.favorite).toBe(true);
    expect(d.type).toBe('apiKey');
    expect(d.hasPassword).toBe(true);
    expect(d.passwordLength).toBe('S3cure!pass'.length);
    expect(JSON.stringify(d)).not.toContain('S3cure!pass'); // detail never carries secrets
    expect(loaded.revealField(id, 'Password')).toBe('S3cure!pass');
    const raw = loaded.findEntry(id);
    expect(raw.fields.get('Password')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(raw.customData?.get(CUSTOM_DATA.type)?.value).toBe('apiKey');
  });

  it('reads item type and favorite written under the old PasswdVault keys', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput({ type: 'login' }));
    const raw = doc.findEntry(id);
    raw.customData = new Map([['PasswdVault.Type', { value: 'apiKey' }], ['PasswdVault.Favorite', { value: 'true' }]]);
    const d = (await roundtrip(doc)).getEntry(id);
    expect(d.type).toBe('apiKey');
    expect(d.favorite).toBe(true);
    doc.setFavorite(id, false);
    expect(doc.findEntry(id).customData?.has('PasswdVault.Favorite')).toBe(false);
    expect(doc.getEntry(id).type).toBe('apiKey');
  });

  it('keeps unchanged secrets, pushes history and supports custom fields', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput({ customFields: [{ name: 'API secret', value: 'abc', protected: true }, { name: 'Region', value: 'eu', protected: false }] }));
    doc.saveEntry(id, entryInput({
      title: 'GitHub 2', password: { keep: true },
      customFields: [{ name: 'API secret (renamed)', originalName: 'API secret', value: { keep: true }, protected: true }, { name: 'Region', value: 'us', protected: false }],
    }));
    const loaded = await roundtrip(doc);
    const d = loaded.getEntry(id);
    expect(d.title).toBe('GitHub 2');
    expect(loaded.revealField(id, 'Password')).toBe('S3cure!pass');
    expect(loaded.revealField(id, 'API secret (renamed)')).toBe('abc');
    expect(d.customFields.find((f) => f.name === 'Region')?.value).toBe('us');
    expect(d.customFields.find((f) => f.name === 'API secret (renamed)')?.value).toBeUndefined();
    expect(d.customFields.some((f) => f.name === 'API secret')).toBe(false);
    expect(d.historyCount).toBe(1);
  });

  it('validates input before mutating anything', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput());
    expect(() => doc.saveEntry(id, entryInput({ title: '   ' }))).toThrow(VaultError);
    expect(() => doc.saveEntry(id, entryInput({ totp: 'not a secret!' }))).toThrow(/authenticator/);
    expect(() => doc.saveEntry(id, entryInput({ customFields: [{ name: 'Password', value: 'x', protected: false }] }))).toThrow(/reserved/);
    expect(() => doc.saveEntry(id, entryInput({ customFields: [{ name: 'a', value: 'x', protected: false }, { name: 'a', value: 'y', protected: false }] }))).toThrow(/Duplicate/);
    expect(() => doc.saveEntry(null, entryInput({ folderId: 'nope' }))).toThrow(/Folder/);
    expect(doc.getEntry(id).historyCount).toBe(0);
    expect(doc.listEntries()).toHaveLength(1);
  });

  it('stores TOTP in KeePassXC format and keeps it', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput({ totp: 'JBSWY3DPEHPK3PXP' }));
    doc.saveEntry(id, entryInput({ totp: { keep: true }, password: { keep: true } }));
    const loaded = await roundtrip(doc);
    expect(loaded.getEntry(id).hasTotp).toBe(true);
    expect(loaded.revealField(id, 'otp')).toMatch(/^otpauth:\/\/totp\/GitHub\?secret=JBSWY3DPEHPK3PXP/);
    expect(loaded.getTotpParams(id)?.digits).toBe(6);
    doc.saveEntry(id, entryInput({ totp: '', password: { keep: true } }));
    expect(doc.getEntry(id).hasTotp).toBe(false);
  });

  it('manages folders, moves, trash and restore', async () => {
    const doc = await newDoc();
    const work = doc.createFolder('Work', null);
    const sub = doc.createFolder('Cloud', work);
    const id = doc.saveEntry(null, entryInput({ folderId: sub }));
    expect(doc.getEntry(id).folderPath).toBe('Work / Cloud');
    expect(doc.deleteEntry(id)).toBe(false);
    expect(doc.getEntry(id).trashed).toBe(true);
    expect(() => doc.saveEntry(id, entryInput())).toThrow(/Restore/);
    doc.restoreEntry(id);
    expect(doc.getEntry(id).folderId).toBe(sub);
    doc.moveEntry(id, work);
    expect(doc.getEntry(id).folderPath).toBe('Work');
    doc.deleteFolder(work);
    expect(doc.getEntry(id).trashed).toBe(true);
    expect(doc.emptyTrash()).toBe(1);
    expect(() => doc.findEntry(id)).toThrow(VaultError);
    expect(doc.listFolders().some((f) => f.name === 'Work')).toBe(false);
    const loaded = await roundtrip(doc);
    expect(loaded.listEntries()).toHaveLength(0);
  });

  it('permanently deletes entries already in the trash', async () => {
    const doc = await newDoc();
    const id = doc.saveEntry(null, entryInput());
    doc.deleteEntry(id);
    expect(doc.deleteEntry(id)).toBe(true);
    expect(doc.listEntries()).toHaveLength(0);
    expect(() => doc.deleteFolder(doc.root.uuid.id)).toThrow();
  });

  it('infers types for entries created by other KeePass clients', async () => {
    const doc = await newDoc();
    const e = doc.db.createEntry(doc.root);
    e.fields.set('Title', 'Only notes');
    e.fields.set('Notes', 'hello');
    expect(doc.summarize(e).type).toBe('note');
    e.fields.set('UserName', 'bob');
    expect(doc.summarize(e).type).toBe('login');
  });

  it('merges concurrent edits from another copy of the database', async () => {
    const base = await newDoc();
    const id = base.saveEntry(null, entryInput());
    const bytes = await base.save();
    const creds = await makeCredentials({ password: pv('master') });
    const a = await VaultDocument.load(bytes, creds);
    const b = await VaultDocument.load(bytes, await makeCredentials({ password: pv('master') }));
    a.saveEntry(null, entryInput({ title: 'From A' }));
    b.saveEntry(id, entryInput({ title: 'Edited in B', password: { keep: true } }));
    // KDBX stores timestamps with 1 s resolution: make B's edit clearly newer.
    b.findEntry(id).times.lastModTime = new Date(Date.now() + 2000);
    b.saveEntry(null, entryInput({ title: 'From B' }));
    a.merge(await VaultDocument.load(await b.save(), creds));
    const titles = a.listEntries().map((e) => e.title).sort();
    expect(titles).toEqual(['Edited in B', 'From A', 'From B']);
  });

  it('imports another vault into a new folder', async () => {
    const src = await newDoc();
    const f = src.createFolder('Shared', null);
    src.saveEntry(null, entryInput({ folderId: f, title: 'Inner' }));
    src.saveEntry(null, entryInput({ title: 'Top' }));
    const dst = await newDoc();
    expect(dst.importVault(src, 'Imported')).toBe(2);
    const paths = dst.listEntries().map((e) => `${e.folderPath}:${e.title}`).sort();
    expect(paths).toEqual(['Imported / Shared:Inner', 'Imported:Top']);
  });

  it('round-trips exportItems/importItems including custom fields and folders', async () => {
    const src = await newDoc();
    const f = src.createFolder('A', null);
    src.saveEntry(null, entryInput({ folderId: f, type: 'card', customFields: [{ name: 'Card number', value: '4111', protected: true }], totp: 'JBSWY3DPEHPK3PXP', favorite: true, tags: ['x'] }));
    const items = src.exportItems();
    const dst = await newDoc();
    dst.importItems(items, 'Imp');
    const [e] = dst.listEntries();
    expect(e.folderPath).toBe('Imp / A');
    expect(e.type).toBe('card');
    expect(e.favorite).toBe(true);
    expect(e.tags).toEqual(['x']);
    expect(dst.revealField(e.id, 'Card number')).toBe('4111');
    expect(dst.getEntry(e.id).customFields[0].protected).toBe(true);
    expect(e.hasTotp).toBe(true);
  });

  it('changes credentials', async () => {
    const doc = await newDoc('old');
    doc.saveEntry(null, entryInput());
    await doc.changeCredentials({ password: pv('new') }, FAST_KDF);
    const bytes = await doc.save();
    await expect(VaultDocument.load(bytes, await makeCredentials({ password: pv('old') }))).rejects.toBeTruthy();
    const loaded = await VaultDocument.load(bytes, await makeCredentials({ password: pv('new') }));
    expect(loaded.listEntries()).toHaveLength(1);
  });

  it('opens KDBX 3.1 files and upgrades them', async () => {
    const creds = await makeCredentials({ password: pv('pw') });
    const legacy = kdbxweb.Kdbx.create(creds, 'Legacy');
    legacy.setVersion(3);
    const e = legacy.createEntry(legacy.getDefaultGroup());
    e.fields.set('Title', 'Old');
    e.fields.set('Password', pv('x'));
    const doc = await VaultDocument.load(new Uint8Array(await legacy.save()), creds);
    expect(doc.formatInfo.kdbxVersion.startsWith('3.')).toBe(true);
    expect(doc.listEntries()[0].title).toBe('Old');
    doc.upgradeFormat(FAST_KDF);
    const up = await VaultDocument.load(await doc.save(), creds);
    expect(up.formatInfo.kdbxVersion.startsWith('4.')).toBe(true);
    expect(up.revealField(up.listEntries()[0].id, 'Password')).toBe('x');
  });
});
