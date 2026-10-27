// Integration tests executed inside a real VS Code extension host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const results = [];

/** Replaces interactive prompts with scripted answers for the duration of fn. */
async function withPrompts(answers, fn) {
  const w = vscode.window;
  const original = { showInputBox: w.showInputBox, showQuickPick: w.showQuickPick, showWarningMessage: w.showWarningMessage, showInformationMessage: w.showInformationMessage };
  const asked = [];
  const next = (kind, prompt) => {
    asked.push(`${kind}: ${prompt}`);
    const a = answers.shift();
    if (!a || a.kind !== kind) throw new Error(`Unexpected ${kind} prompt "${prompt}" (next answer: ${a && a.kind})`);
    return a.value;
  };
  w.showInputBox = async (o) => next('input', (o && (o.title || o.prompt)) || '');
  w.showQuickPick = async (items, o) => {
    const list = await items;
    const v = next('pick', (o && o.title) || '');
    return typeof v === 'function' ? v(list) : v;
  };
  w.showWarningMessage = async (msg, ...rest) => (answers[0] && answers[0].kind === 'warn' ? next('warn', msg) : undefined);
  w.showInformationMessage = async () => undefined;
  try {
    await fn();
    if (answers.length) throw new Error(`Unused answers: ${JSON.stringify(answers)}; asked: ${asked.join(' | ')}`);
  } finally {
    Object.assign(w, original);
  }
}
const input = (value) => ({ kind: 'input', value });
const pick = (value) => ({ kind: 'pick', value });
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
  const ext = vscode.extensions.getExtension('hacknseek.vaultnest');
  assert.ok(ext, 'extension is installed');
  console.log('activating VaultNest…');
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
    await vscode.workspace.getConfiguration('vaultnest').update('clipboard.clearAfterSeconds', 1, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vaultnest.copyPassword', { vaultId, entryId });
    assert.equal(await vscode.env.clipboard.readText(), 'Sup3r$ecret!');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), '');
  });

  await test('clipboard is not cleared if the user copied something else', async () => {
    await vscode.commands.executeCommand('vaultnest.copyUsername', { vaultId, entryId });
    await vscode.commands.executeCommand('vaultnest.copyPassword', { vaultId, entryId });
    await vscode.env.clipboard.writeText('user content');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), 'user content');
  });

  await test('TOTP copy produces a 6-digit code', async () => {
    await vscode.commands.executeCommand('vaultnest.copyTotp', { vaultId, entryId });
    assert.match(await vscode.env.clipboard.readText(), /^\d{6}$/);
  });

  await test('dashboard opens and builds a secret-free state', async () => {
    await vscode.commands.executeCommand('vaultnest.openDashboard', { vaultId });
    await new Promise((r) => setTimeout(r, 500));
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('vaultnest.dashboard'));
    assert.ok(tab, 'dashboard tab is open');
    const state = manager.info(manager.ref(vaultId));
    assert.equal(state.locked, false);
    const summary = manager.doc(vaultId).listEntries();
    assert.ok(!JSON.stringify(summary).includes('Sup3r$ecret!'));
  });

  await test('dashboard RPC: validated requests reach the host, secrets only on reveal', async () => {
    const panel = api.dashboard();
    assert.ok(panel);
    const sent = [];
    const origPost = panel.post.bind(panel);
    panel.post = (m) => { sent.push(m); origPost(m); };
    const call = async (id, method, params) => {
      await panel.onMessage({ kind: 'request', id, method, params });
      const r = sent.find((m) => m.kind === 'response' && m.id === id);
      assert.ok(r, `response for ${method}`);
      return r;
    };
    try {
      const ready = await call(9001, 'ready', {});
      assert.equal(ready.ok, true);
      assert.ok(!JSON.stringify(ready.result).includes('Sup3r$ecret!'), 'state must not contain secrets');
      assert.equal(ready.result.entries.length, 1);
      const detail = await call(9002, 'getEntry', { vaultId, entryId });
      assert.ok(!JSON.stringify(detail.result).includes('Sup3r$ecret!'));
      const revealed = await call(9003, 'reveal', { vaultId, entryId, field: 'Password' });
      assert.equal(revealed.result, 'Sup3r$ecret!');
      const bad = await call(9004, 'reveal', { vaultId, entryId, field: 'Password', extra: true });
      assert.equal(bad.ok, false);
      const unknown = await call(9005, 'runShell', { cmd: 'ls' });
      assert.equal(unknown.ok, false);
      const created = await call(9006, 'saveEntry', { vaultId, entryId: null, input: {
        type: 'apiKey', title: 'Via RPC', username: 'id', password: 'k3y', url: '', notes: '', tags: [], favorite: false,
        folderId: null, expires: null, totp: '', customFields: [{ name: 'Env', value: 'prod', protected: false }] } });
      assert.equal(created.ok, true);
      const kept = await call(9007, 'saveEntry', { vaultId, entryId: created.result, input: {
        type: 'apiKey', title: 'Via RPC (renamed)', username: 'id', password: { keep: true }, url: '', notes: '', tags: [], favorite: false,
        folderId: null, expires: null, totp: { keep: true }, customFields: [] } });
      assert.equal(kept.ok, true);
      assert.equal(manager.doc(vaultId).revealField(created.result, 'Password'), 'k3y');
      const gen = await call(9008, 'generate', { options: { ...actions.generatorOptions(), length: 32 } });
      assert.equal(gen.result.value.length, 32);
      await manager.mutate(vaultId, (d) => { d.deleteEntry(created.result); d.deleteEntry(created.result); });
    } finally {
      panel.post = origPost;
    }
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
    await vscode.commands.executeCommand('vaultnest.lockAll');
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

  await test('unlock command asks for the master password and retries after a wrong one', async () => {
    await withPrompts([input('wrong password'), input('correct horse battery staple')], async () => {
      await vscode.commands.executeCommand('vaultnest.unlock', { vaultId });
    });
    assert.equal(manager.isUnlocked(vaultId), true);
  });

  await test('cancelling the unlock prompt keeps the vault locked', async () => {
    await manager.lockAll('test');
    await withPrompts([input(undefined)], async () => {
      await vscode.commands.executeCommand('vaultnest.unlock', { vaultId });
    });
    assert.equal(manager.isUnlocked(vaultId), false);
  });

  await test('change master password flow re-authenticates and re-encrypts', async () => {
    await withPrompts([input('correct horse battery staple')], () => vscode.commands.executeCommand('vaultnest.unlock', { vaultId }));
    await withPrompts([input('not the current one')], () => vscode.commands.executeCommand('vaultnest.changeMasterPassword', { vaultId }));
    await withPrompts([input('correct horse battery staple'), input('N3w-master-Passw0rd-2026!'), input('N3w-master-Passw0rd-2026!')],
      () => vscode.commands.executeCommand('vaultnest.changeMasterPassword', { vaultId }));
    await manager.lockAll('test');
    await withPrompts([input('correct horse battery staple'), input('N3w-master-Passw0rd-2026!')], () => vscode.commands.executeCommand('vaultnest.unlock', { vaultId }));
    assert.equal(manager.isUnlocked(vaultId), true);
    assert.equal(manager.doc(vaultId).revealField(entryId, 'Password'), 'Sup3r$ecret!');
  });

  await test('VaultNest CSV export requires confirmation and the master password', async () => {
    const target = path.join(tmp, 'export.csv');
    const origSave = vscode.window.showSaveDialog;
    vscode.window.showSaveDialog = async () => vscode.Uri.file(target);
    try {
      await withPrompts([pick((items) => items[1]), { kind: 'warn', value: 'Export Unencrypted' }, input('N3w-master-Passw0rd-2026!')],
        () => vscode.commands.executeCommand('vaultnest.export', { vaultId }));
    } finally {
      vscode.window.showSaveDialog = origSave;
    }
    const csv = fs.readFileSync(target, 'utf8');
    assert.match(csv, /Sup3r\$ecret!/);
    assert.match(csv, /^folder,favorite,type,name/);
  });

  await test('create vault flow (name → location → master password)', async () => {
    const before = manager.refs().length;
    await withPrompts([
      input('Flow Vault'),
      pick((items) => items[0]), // private extension storage
      input('Tr0ub4dor&3-horse-Battery-staple'),
      input('Tr0ub4dor&3-horse-Battery-staple'),
    ], () => vscode.commands.executeCommand('vaultnest.createVault'));
    const ref = manager.refs().find((r) => r.name === 'Flow Vault');
    assert.ok(ref, 'vault registered');
    assert.equal(manager.refs().length, before + 1);
    assert.equal(manager.isUnlocked(ref.id), true);
    assert.equal(manager.doc(ref.id).formatInfo.kdf, 'Argon2id');
    assert.equal(manager.doc(ref.id).formatInfo.kdfMemoryMiB, 64);
    await manager.removeRef(ref.id);
    fs.rmSync(ref.path, { force: true });
  });

  await test('weak master passwords need explicit confirmation', async () => {
    await withPrompts([
      input('Weak Vault'),
      pick((items) => items[0]),
      input('password1'),
      input('password1'),
      { kind: 'warn', value: 'Choose Another' },
      input(undefined),
    ], () => vscode.commands.executeCommand('vaultnest.createVault'));
    assert.ok(!manager.refs().some((r) => r.name === 'Weak Vault'));
  });

  await test('removing the vault keeps the file', async () => {
    await manager.removeRef(vaultId);
    assert.ok(fs.existsSync(file));
    assert.equal(manager.refs().length, 0);
  });

  await vscode.workspace.getConfiguration('vaultnest').update('clipboard.clearAfterSeconds', undefined, vscode.ConfigurationTarget.Global);
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
};
