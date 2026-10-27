// Build script: bundles the extension host (Node/CommonJS) and the webview (browser/IIFE).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Copies static webview assets (codicons) into dist/. */
function copyAssets() {
  const out = path.join('dist', 'media');
  fs.mkdirSync(out, { recursive: true });
  const codicons = path.join('node_modules', '@vscode', 'codicons', 'dist');
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(codicons, file), path.join(out, file));
  }
}

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'linked',
};

// Start from a clean output folder so stale files (e.g. dev source maps) never get packaged.
fs.rmSync('dist', { recursive: true, force: true });

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: 'src/webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'css' },
  }),
]);

copyAssets();
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
