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
  const ext = vscode.extensions.getExtension('hacknseek.passwdmanager');
  assert.ok(ext, 'extension is installed');
  console.log('activating PasswdManager…');
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
    await vscode.workspace.getConfiguration('passwdmanager').update('clipboard.clearAfterSeconds', 1, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('passwdmanager.copyPassword', { vaultId, entryId });
    assert.equal(await vscode.env.clipboard.readText(), 'Sup3r$ecret!');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), '');
  });

  await test('clipboard is not cleared if the user copied something else', async () => {
    await vscode.commands.executeCommand('passwdmanager.copyUsername', { vaultId, entryId });
    await vscode.commands.executeCommand('passwdmanager.copyPassword', { vaultId, entryId });
    await vscode.env.clipboard.writeText('user content');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await vscode.env.clipboard.readText(), 'user content');
  });

  await test('TOTP copy produces a 6-digit code', async () => {
    await vscode.commands.executeCommand('passwdmanager.copyTotp', { vaultId, entryId });
    assert.match(await vscode.env.clipboard.readText(), /^\d{6}$/);
  });

  await test('dashboard opens and builds a secret-free state', async () => {
    await vscode.commands.executeCommand('passwdmanager.openDashboard', { vaultId });
    await new Promise((r) => setTimeout(r, 500));
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('passwdmanager.dashboard'));
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
    await vscode.commands.executeCommand('passwdmanager.lockAll');
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
      await vscode.commands.executeCommand('passwdmanager.unlock', { vaultId });
    });
    assert.equal(manager.isUnlocked(vaultId), true);
  });

  await test('cancelling the unlock prompt keeps the vault locked', async () => {
    await manager.lockAll('test');
    await withPrompts([input(undefined)], async () => {
      await vscode.commands.executeCommand('passwdmanager.unlock', { vaultId });
    });
    assert.equal(manager.isUnlocked(vaultId), false);
  });

  await test('change master password flow re-authenticates and re-encrypts', async () => {
    await withPrompts([input('correct horse battery staple')], () => vscode.commands.executeCommand('passwdmanager.unlock', { vaultId }));
    await withPrompts([input('not the current one')], () => vscode.commands.executeCommand('passwdmanager.changeMasterPassword', { vaultId }));
    await withPrompts([input('correct horse battery staple'), input('N3w-master-Passw0rd-2026!'), input('N3w-master-Passw0rd-2026!')],
      () => vscode.commands.executeCommand('passwdmanager.changeMasterPassword', { vaultId }));
    await manager.lockAll('test');
    await withPrompts([input('correct horse battery staple'), input('N3w-master-Passw0rd-2026!')], () => vscode.commands.executeCommand('passwdmanager.unlock', { vaultId }));
    assert.equal(manager.isUnlocked(vaultId), true);
    assert.equal(manager.doc(vaultId).revealField(entryId, 'Password'), 'Sup3r$ecret!');
  });

  await test('PasswdManager CSV export requires confirmation and the master password', async () => {
    const target = path.join(tmp, 'export.csv');
    const origSave = vscode.window.showSaveDialog;
    vscode.window.showSaveDialog = async () => vscode.Uri.file(target);
    try {
      await withPrompts([pick((items) => items[1]), { kind: 'warn', value: 'Export Unencrypted' }, input('N3w-master-Passw0rd-2026!')],
        () => vscode.commands.executeCommand('passwdmanager.export', { vaultId }));
    } finally {
      vscode.window.showSaveDialog = origSave;
    }
    const csv = fs.readFileSync(target, 'utf8');
    assert.match(csv, /Sup3r\$ecret!/);
    assert.match(csv, /^folder,favorite,type,name/);
  });

  // ---------------------------------------------------------------- 2FA from QR codes
  const fixture = (name) => path.join(__dirname, 'fixtures', name);
  const withOpenDialog = async (file, fn) => {
    const original = vscode.window.showOpenDialog;
    vscode.window.showOpenDialog = async () => [vscode.Uri.file(file)];
    try { await fn(); } finally { vscode.window.showOpenDialog = original; }
  };
  const ACME_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  await test('2FA: set up an item from a QR image file (replacing the old key)', async () => {
    await withOpenDialog(fixture('totp.png'), () => withPrompts([pick((items) => items[1]), { kind: 'warn', value: 'Replace' }],
      () => vscode.commands.executeCommand('passwdmanager.setupTotpFromQr', { vaultId, entryId })));
    const doc = manager.doc(vaultId);
    assert.match(doc.revealField(entryId, 'otp'), new RegExp(`secret=${ACME_SECRET}`));
    assert.match(actions.getTotp(vaultId, entryId).code, /^\d{6}$/);
    assert.ok(doc.getEntry(entryId).historyCount >= 1, 'old key kept in history');
  });

  await test('2FA: import a Google Authenticator export as new items', async () => {
    const before = manager.doc(vaultId).listEntries().length;
    await withOpenDialog(fixture('migration.png'), () => withPrompts([pick((items) => items[1]), pick((items) => items)],
      () => vscode.commands.executeCommand('passwdmanager.addTotpFromQr')));
    const entries = manager.doc(vaultId).listEntries().filter((e) => e.tags.includes('2fa'));
    assert.equal(manager.doc(vaultId).listEntries().length, before + 2);
    const gitlab = entries.find((e) => e.title === 'GitLab');
    assert.ok(gitlab && gitlab.username === 'alice@example.com' && gitlab.hasTotp);
    assert.ok(entries.find((e) => e.title === 'Example' && e.username === 'bob'));
    // The RFC 6238 test secret, decoded from the export payload
    const params = manager.doc(vaultId).getTotpParams(gitlab.id);
    assert.equal(Buffer.from(params.secret).toString(), '12345678901234567890');
    await manager.mutate(vaultId, (d) => { for (const e of entries) { d.deleteEntry(e.id); d.deleteEntry(e.id); } });
  });

  await test('2FA: dashboard decodes a pasted QR image (account chosen in the host)', async () => {
    const panel = api.dashboard();
    assert.ok(panel);
    const sent = [];
    const origPost = panel.post.bind(panel);
    panel.post = (m) => { sent.push(m); origPost(m); };
    try {
      const image = fs.readFileSync(fixture('migration.png')).toString('base64');
      await withPrompts([pick((items) => items[1])], () => panel.onMessage({ kind: 'request', id: 9101, method: 'decodeQrImage', params: { image } }));
      const r = sent.find((m) => m.kind === 'response' && m.id === 9101);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.result.issuer, 'Example');
      assert.equal(r.result.account, 'bob');
      assert.match(r.result.uri, /^otpauth:\/\/totp\//);
      await panel.onMessage({ kind: 'request', id: 9102, method: 'decodeQrImage', params: { image: 'not base64!' } });
      assert.equal(sent.find((m) => m.id === 9102).ok, false);
    } finally {
      panel.post = origPost;
    }
  });

  const canCapture = process.platform === 'linux' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    && ['/usr/bin/import', '/usr/bin/scrot', '/usr/bin/maim'].some((p) => fs.existsSync(p));
  if (canCapture) {
    await test('2FA: scan a QR code shown on the screen (real screenshot)', async () => {
      await manager.mutate(vaultId, (d) => d.setTotp(entryId, ''));
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fixture('totp.png')));
      await new Promise((r) => setTimeout(r, 2000));
      actions.totpQr.countdownSeconds = 0;
      try {
        await withPrompts([pick((items) => items[0])], () => vscode.commands.executeCommand('passwdmanager.setupTotpFromQr', { vaultId, entryId }));
      } finally {
        actions.totpQr.countdownSeconds = 5;
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      assert.match(manager.doc(vaultId).revealField(entryId, 'otp'), new RegExp(`secret=${ACME_SECRET}`));
    });
  } else {
    console.log('- skipping the screen-capture test (no X11 screenshot tool)');
  }

  await test('create vault flow (name → location → master password)', async () => {
    const before = manager.refs().length;
    await withPrompts([
      input('Flow Vault'),
      pick((items) => items[0]), // private extension storage
      input('Tr0ub4dor&3-horse-Battery-staple'),
      input('Tr0ub4dor&3-horse-Battery-staple'),
    ], () => vscode.commands.executeCommand('passwdmanager.createVault'));
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
    ], () => vscode.commands.executeCommand('passwdmanager.createVault'));
    assert.ok(!manager.refs().some((r) => r.name === 'Weak Vault'));
  });

  await test('removing the vault keeps the file', async () => {
    await manager.removeRef(vaultId);
    assert.ok(fs.existsSync(file));
    assert.equal(manager.refs().length, 0);
  });

  await vscode.workspace.getConfiguration('passwdmanager').update('clipboard.clearAfterSeconds', undefined, vscode.ConfigurationTarget.Global);
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
};
