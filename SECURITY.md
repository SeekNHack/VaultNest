# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's *Report a vulnerability* (private security advisory) on <https://github.com/SeekNHack/PasswdVault/security>. Include a description, the affected version and reproduction steps.

## Threat model

VaultNest protects secrets **at rest** and limits their exposure **while in use** inside VS Code.

**In scope**

- Theft or copy of the vault file or its backups (stolen laptop, leaked sync folder, accidental commit): the file is a KDBX 4 database encrypted with AES-256 (or ChaCha20 for imported files) under a key derived with Argon2id. Its security depends on the strength of the master password.
- Shoulder-surfing and accidental disclosure: secrets are masked by default, revealed values re-mask after 30 seconds, the clipboard is cleared automatically, and vaults auto-lock.
- Data loss: atomic writes, decryption check before replacing the file, rotating backups, merge of concurrent changes, recovery copy if saving fails.
- Content injected through vault data (malicious titles, URLs or notes in an imported file): the dashboard renders text with DOM APIs only (no `innerHTML`), runs under a strict CSP with nonce-only scripts, and only opens `http(s)`, `ftp`, `sftp`, `ssh` and `mailto` links.

**Out of scope** (no software-only password manager can fully defend against these)

- Malware or another user with access to your running session: it can read the memory of VS Code, log keystrokes or read the clipboard.
- **Other VS Code extensions.** All extensions run in the same extension host process, without isolation from each other. Install only extensions you trust while vaults are unlocked.
- A compromised VS Code installation or operating system.

## Design decisions

| Topic | Decision |
|---|---|
| Cryptography | No custom crypto. The KDBX format, AES/ChaCha20 and HMAC come from **kdbxweb**. Argon2 comes from **hash-wasm** (WebAssembly build of the reference implementation). Random numbers come from Node's `crypto.randomInt` / `randomBytes` (OS CSPRNG). |
| Key derivation | New vaults: KDBX 4, Argon2id, 64 MiB, 3 iterations, parallelism 2 (configurable). Opening KDBX 3.1/AES-KDF files works, and the dashboard offers to upgrade them. |
| Master password | Typed in a native VS Code password input box, converted at once into a `ProtectedValue` and never stored. Changing the master password or exporting to plain CSV asks for the current one again. |
| Memory | Protected fields are kept XOR-masked with a random key (`ProtectedValue`). Locking drops every reference to the decrypted database. |
| Webview | `enableCommandUris: false`, `localResourceRoots` limited to `dist/`, CSP `default-src 'none'`. The webview gets item summaries without secrets; a protected value crosses the boundary only after a *reveal* or *edit* action, one field at a time. Every incoming message is checked against a strict schema. |
| Clipboard | Only a SHA-256 hash of the copied value is kept, to decide whether the clipboard may be cleared. |
| Persistence | Vault paths and preferences are kept in VS Code global/workspace state; secrets never are. New files are created with mode `0600`. |
| Network / AI | The extension makes no network requests and does not use the VS Code Language Model or Chat APIs. Secrets reach an editor only when you run *Insert into Editor*, and a warning is shown the first time. |
| 2FA | The authenticator key is typed or pasted by the user (setup key or `otpauth://` URI) and stored as a protected field. VaultNest does not read QR codes or capture the screen. |
| Exports | Plain-text exports show a warning and require the master password again. CSV values are written exactly as stored, never altered. |

## Known limitations

1. **JavaScript memory hygiene.** Strings in JavaScript are immutable and garbage-collected, so they cannot be wiped reliably. The master password (from the input box), revealed values and values being edited may stay in memory until the garbage collector reclaims them. This limitation applies to every JavaScript/Electron password manager.
2. **Shared extension host.** See *Out of scope*: another installed extension could read process memory or wrap VS Code APIs.
3. **Clipboard.** Clipboard managers, remote desktop or clipboard sync may keep copies that VaultNest cannot clear. In web/remote VS Code setups, reading the clipboard can fail; then it is not cleared automatically.
4. **Inactivity detection** relies on editor, terminal and window events. Activity in some other views (for example a terminal running a long job with no input) may not count as activity.
5. **Strength estimate.** The strength meter and the *weak* check of the health report only measure length and character variety. They do not recognize dictionary words, common or leaked passwords, names or keyboard patterns, so a password like `Password123!` (79 bits) is rated *Good*. Use the generator for new passwords.
6. **Attachments** stored by other KDBX apps are kept and listed, but cannot be opened or edited in VaultNest yet.
7. **Merging** uses the standard KDBX merge semantics with 1-second timestamp resolution. Two edits of the *same item* within the same second on two devices resolve in favor of the local copy, and the overwritten version stays in the item history.
8. **Argon2 v1.0 (0x10)** files are not supported (very rare; resave them in a current KDBX app).
9. **Dependencies.** The bundled `@xmldom/xmldom` is pinned to 0.8.15 through an npm `overrides` entry (kdbxweb 2.1.1 asks for 0.7.x, which has known advisories). `npm audit --omit=dev` reports no vulnerabilities. The remaining advisory affects only the `@vscode/vsce` packaging tool, which is not part of the extension.
10. **Not independently audited.** This project has unit and integration tests but **has not undergone an independent security audit**. A professional review should focus on: the webview ↔ host boundary (`src/host/views/DashboardPanel.ts`, `rpcValidation.ts`), the save/merge pipeline (`src/core/vault/VaultSession.ts`, `VaultStorage.ts`), the credential and KDF handling (`VaultDocument.ts`, `argon2.ts`), and the supply chain of the bundled dependencies.
