// Writes THIRD_PARTY_LICENSES.txt with the full license text of every bundled dependency.
const fs = require('fs');
const path = require('path');
const pkgs = ['kdbxweb', '@xmldom/xmldom', 'hash-wasm', '@vscode/codicons'];
let out = 'VaultNest bundles the following third-party software. Their licenses follow.\n';
for (const name of pkgs) {
  const dir = path.join('node_modules', name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`No license file for ${name}`);
  out += `\n${'='.repeat(78)}\n${name}@${meta.version} (${meta.license})\n${'='.repeat(78)}\n\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`;
}
out += `\n${'='.repeat(78)}\nEFF Large Wordlist (CC BY 3.0 US)\n${'='.repeat(78)}\n\n© Electronic Frontier Foundation. https://www.eff.org/dice — licensed under https://creativecommons.org/licenses/by/3.0/us/\n`;
fs.writeFileSync('THIRD_PARTY_LICENSES.txt', out);
