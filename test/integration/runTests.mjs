// Launches a real VS Code instance (downloaded by @vscode/test-electron) with the
// extension under development and runs test/integration/suite/index.cjs inside it.
import { runTests } from '@vscode/test-electron';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const userData = mkdtempSync(path.join(tmpdir(), 'pv-vscode-'));
const extensionPath = process.env.PV_EXTENSION_PATH ?? root;
// The suite must live inside the extension folder: VS Code hands each extension its own
// `vscode` API instance based on the requiring file's location (needed to stub prompts).
let suite = path.join(root, 'test/integration/suite/index.cjs');
if (extensionPath !== root) {
  mkdirSync(path.join(extensionPath, '.test-suite'), { recursive: true });
  copyFileSync(suite, path.join(extensionPath, '.test-suite', 'index.cjs'));
  suite = path.join(extensionPath, '.test-suite', 'index.cjs');
}
try {
  await runTests({
    // PV_EXTENSION_PATH lets CI run the suite against an unpacked .vsix (no node_modules).
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: suite,
    launchArgs: ['--disable-extensions', '--skip-welcome', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
