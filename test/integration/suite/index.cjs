// Integration tests executed inside a real VS Code extension host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const results = [];
async function test(name, fn) {
  console.log(`… ${name}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 20s')), 20000); })]);
    results.push(['PASS', name]);
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push(['FAIL', name, err]);
    console.log(`✘ ${name}\n    ${err && err.stack}`);
  } finally {
    clearTimeout(timer);
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('SeekNHack.passwdvault');
  assert.ok(ext, 'extension is installed');
  console.log('activating PasswdVault…');
  const api = await ext.activate();
  console.log('activated');
  assert.ok(api && api.manager, 'test API is available in test mode');
  const { manager, actions, tree } = api;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-int-'));
  const file = path.join(tmp, 'Integration.kdbx');

  await test('all contributed commands are registered', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8'));
    const all = await vscode.commands.getCommands(true);
    for (const c of pkg.contributes.commands) assert.ok(all.includes(c.command), `missing command ${c.command}`);
  });

  await test('starts with no unlocked vault', async () => {
    assert.equal(manager.hasUnlocked(), false);
  });

  let vaultId;
  let entryId;
  await test('create a vault and add an item (programmatic flow)', async () => {
    const ref = await manager.addRef({ name: 'Integration', path: file, scope: 'global' });
    vaultId = ref.id;
    const { kdbxweb, VaultSession } = api;
    const created = await VaultSession.create(file, 'Integration', { password: kdbxweb.ProtectedValue.fromString('correct horse battery staple') },
      { memoryMiB: 8, iterations: 1, parallelism: 1 }, manager.hooksFor(vaultId));
    manager.adoptSession(vaultId, created);
    assert.equal(manager.isUnlocked(vaultId), true);
    entryId = await manager.mutate(vaultId, (d) => d.saveEntry(null, {
      type: 'login', title: 'Example', username: 'alice', password: 'Sup3r$ecret!', url: 'https://example.com', notes: '',
      tags: ['test'], favorite: true, folderId: null, expires: null, totp: 'JBSWY3DPEHPK3PXP', customFields: [],
    }));
    assert.ok(fs.existsSync(file));
  });

  await test('tree view shows vault, favorites and item', async () => {
    const roots = tree.getChildren();
    const vaultNode = roots.find((n) => n.vaultId === vaultId);
    assert.ok(vaultNode);
    const children = tree.getChildren(vaultNode);
    assert.ok(children.some((n) => n.kind === 'favorites'));
    const entryNode = children.find((n) => n.kind === 'entry');
    assert.equal(entryNode.entry.title, 'Example');
    const item = tree.getTreeItem(entryNode);
    assert.match(item.contextValue, /^entry-active-url-totp$/);
    assert.ok(!JSON.stringify(item.tooltip).includes('Sup3r$ecret!'), 'tooltip must not contain the password');
  });

  await test('copy password command writes clipboard and clears it', async () => {
    await vscode.workspace.getConfiguration('passwdvault').update('clipboard.clearAfterSeconds', 1, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('passwdvault.copyPassword', { vaultId, entryId });
    assert.equal(await vscode.env.clipboard.readText(), 'Sup3r$ecret!');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), '');
  });

  await test('clipboard is not cleared if the user copied something else', async () => {
    await vscode.commands.executeCommand('passwdvault.copyUsername', { vaultId, entryId });
    await vscode.commands.executeCommand('passwdvault.copyPassword', { vaultId, entryId });
    await vscode.env.clipboard.writeText('user content');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), 'user content');
  });

  await test('TOTP copy produces a 6-digit code', async () => {
    await vscode.commands.executeCommand('passwdvault.copyTotp', { vaultId, entryId });
    assert.match(await vscode.env.clipboard.readText(), /^\d{6}$/);
  });

  await test('dashboard opens and builds a secret-free state', async () => {
    await vscode.commands.executeCommand('passwdvault.openDashboard', { vaultId });
    await new Promise((r) => setTimeout(r, 500));
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('passwdvault.dashboard'));
    assert.ok(tab, 'dashboard tab is open');
    const state = manager.info(manager.ref(vaultId));
    assert.equal(state.locked, false);
    const summary = manager.doc(vaultId).listEntries();
    assert.ok(!JSON.stringify(summary).includes('Sup3r$ecret!'));
  });

  await test('health report flags nothing for a strong unique password', async () => {
    const r = manager.healthReport(vaultId);
    assert.equal(r.total, 1);
    assert.equal(r.counts.weak, 0);
  });

  await test('generator produces strong passwords', async () => {
    const g = actions.generate({ ...actions.generatorOptions(), mode: 'password', length: 24 });
    assert.equal(g.value.length, 24);
    assert.equal(g.strength.score, 4);
  });

  await test('lockAll drops decrypted data and re-unlock is required', async () => {
    await vscode.commands.executeCommand('passwdvault.lockAll');
    assert.equal(manager.isUnlocked(vaultId), false);
    assert.throws(() => manager.doc(vaultId), /locked/);
    const vaultNode = tree.getChildren().find((n) => n.vaultId === vaultId);
    assert.deepEqual(tree.getChildren(vaultNode), []);
  });

  await test('the saved file unlocks with the master password and contains the item', async () => {
    const { kdbxweb } = api;
    const session = manager.session(vaultId);
    await session.unlock({ password: kdbxweb.ProtectedValue.fromString('correct horse battery staple') });
    assert.equal(session.doc.revealField(entryId, 'Password'), 'Sup3r$ecret!');
    // First save after unlocking must back up the previous file.
    await manager.mutate(vaultId, (d) => d.setFavorite(entryId, false));
    await manager.lockAll('test');
  });

  await test('backups were created', async () => {
    const dir = manager.backupDirectory(manager.ref(vaultId));
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.endsWith('.kdbx')));
  });

  await test('removing the vault keeps the file', async () => {
    await manager.removeRef(vaultId);
    assert.ok(fs.existsSync(file));
    assert.equal(manager.refs().length, 0);
  });

  await vscode.workspace.getConfiguration('passwdvault').update('clipboard.clearAfterSeconds', undefined, vscode.ConfigurationTarget.Global);
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
};
