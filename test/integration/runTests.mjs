// Launches a real VS Code instance (downloaded by @vscode/test-electron) with the
// extension under development and runs test/integration/suite/index.cjs inside it.
import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const userData = mkdtempSync(path.join(tmpdir(), 'pv-vscode-'));
try {
  await runTests({
    // PV_EXTENSION_PATH lets CI run the suite against an unpacked .vsix (no node_modules).
    extensionDevelopmentPath: process.env.PV_EXTENSION_PATH ?? root,
    extensionTestsPath: path.join(root, 'test/integration/suite/index.cjs'),
    launchArgs: ['--disable-extensions', '--skip-welcome', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
