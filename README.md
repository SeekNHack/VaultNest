# PasswdVault

**A secure, local-first password manager inside Visual Studio Code.**

PasswdVault keeps your passwords, API keys, tokens, SSH keys and notes in an encrypted **KeePass-compatible (KDBX 4)** file stored on your machine. No cloud, no account, no telemetry — and the same file opens in KeePassXC, KeePass, KeeWeb or Strongbox.

> Install the extension and you're done: all libraries are bundled. You do **not** need KeePass or anything else installed.

## Features

- **Encrypted vaults** — KDBX 4 with AES-256 and Argon2id key derivation, protected by a master password (optionally plus a KeePass key file). Create several vaults; each one can be *global* (every VS Code window) or tied to a workspace.
- **Locked by default** — vaults are locked when VS Code starts, after a configurable inactivity period, on demand (`Ctrl+Alt+L`) and optionally when the window loses focus. The master password is never stored.
- **Everything a developer keeps secret** — logins, API keys, tokens, SSH keys, cards and secure notes, with custom fields (plain or hidden), folders, tags, favorites, expiry dates and TOTP authenticator codes.
- **Dashboard** — a tab with search, filters by type/folder/tag, item details, an editor, a password generator, a password-health report and vault settings. It follows your light, dark or high-contrast theme.
- **Sidebar & quick access** — an Activity Bar view with vaults, folders and items; one-click copy of usernames and passwords; `Ctrl+Alt+P` (`Cmd+Alt+P` on macOS) searches every unlocked vault from anywhere.
- **Password generator** — random passwords (length, character sets, minimum digits/symbols, avoid ambiguous characters) or EFF-wordlist passphrases, from a cryptographically secure generator, with a strength meter. Copy the result, insert it into the editor or save it as a new item.
- **Password health** — finds weak, reused, old and expired passwords and http:// URLs. The analysis runs locally.
- **Safe clipboard** — copied secrets are cleared after 30 s (configurable), but only if the clipboard still holds them.
- **No data loss** — atomic, verified saves; rotating encrypted backups; automatic merge when another app (KeePassXC, a sync client) changed the file; an encrypted recovery copy if a save ever fails.
- **Import/export** — import KeePass `.kdbx`, Bitwarden (JSON/CSV), KeePassXC CSV and Chrome/Edge/Firefox/Safari CSV. Export to `.kdbx` (encrypted) or CSV (with explicit warnings and re-authentication).

## Getting started

1. Click the **PasswdVault** shield in the Activity Bar.
2. Choose **Create New Vault** (or **Open Existing .kdbx**).
3. Pick a name and a location, then a strong master password. **It cannot be recovered if you forget it.**
4. Add items from the **+** button in the sidebar or from the dashboard (**PasswdVault: Open Dashboard**).

### Everyday use

| Action | How |
|---|---|
| Search and copy | `Ctrl+Alt+P` / `Cmd+Alt+P` → type → use the inline buttons (username, password, TOTP, open URL) or press Enter for more actions |
| Copy from the sidebar | Hover an item → key / person icons, or right-click |
| Insert a secret into a file | **PasswdVault: Insert Secret into Editor…** (e.g. into a local `.env`) |
| Generate a password | **PasswdVault: Generate Password…** or the generator in the dashboard |
| Lock everything | `Ctrl+Alt+L` / `Cmd+Alt+L`, the lock icon, or the status bar item |

Dashboard shortcuts: `Ctrl+F` or `/` search · `Ctrl+N` new item · `E` edit selected item · `Ctrl+S` save · `Esc` cancel · `Ctrl+G` generator · `Ctrl+L` lock.

### Using the vault in other apps and on other devices

The vault is a standard KeePass file. To use it elsewhere, create it (or move it) in a folder you sync yourself — Syncthing, Nextcloud, Dropbox, a USB stick — and open it with KeePassXC, KeePassDX, Strongbox, etc. When the file changes on disk, PasswdVault merges the changes on its next save, or right away with **Reload / Merge Changes from Disk**.

PasswdVault-specific metadata (item type, favorite) is kept in KDBX 4 `CustomData`, which other clients ignore and preserve.

## Settings

| Setting | Default | Description |
|---|---|---|
| `passwdvault.autoLock.minutes` | `15` | Lock after this many minutes without activity in VS Code (`0` = never) |
| `passwdvault.autoLock.onWindowBlur` | `false` | Lock when the VS Code window loses focus |
| `passwdvault.autoLock.blurGraceSeconds` | `0` | Delay before the focus-loss lock |
| `passwdvault.clipboard.clearAfterSeconds` | `30` | Clear copied secrets after N seconds (`0` = never) |
| `passwdvault.backup.enabled` | `true` | Keep rotating encrypted backups |
| `passwdvault.backup.count` | `10` | Backups kept per vault |
| `passwdvault.backup.intervalMinutes` | `60` | Minimum minutes between automatic backups |
| `passwdvault.backup.location` | `extensionStorage` | `extensionStorage` or `besideVault` (`.passwdvault-backups/` next to the file) |
| `passwdvault.security.kdfMemoryMiB` | `64` | Argon2id memory for new vaults / password changes |
| `passwdvault.security.kdfIterations` | `3` | Argon2id iterations for new vaults / password changes |
| `passwdvault.security.minMasterPasswordScore` | `2` | Minimum zxcvbn score (0–4) for new master passwords before a warning |
| `passwdvault.ui.showPasswordStrength` | `true` | Strength meter in the editor |
| `passwdvault.ui.openDashboardOnUnlock` | `false` | Open the dashboard after unlocking |
| `passwdvault.ui.showStatusBar` | `true` | Status bar lock indicator |
| `passwdvault.health.maxPasswordAgeDays` | `365` | Age after which a password is reported as old |

## Security

- Encryption and the file format come from established libraries ([kdbxweb](https://github.com/keeweb/kdbxweb), Argon2 from [hash-wasm](https://github.com/Daninet/hash-wasm)). PasswdVault does not implement its own cryptography.
- Decrypted data exists only in the memory of the VS Code extension host while a vault is unlocked. Protected fields stay XOR-masked in memory (kdbxweb `ProtectedValue`) until they are used.
- The dashboard runs with a strict Content Security Policy and never receives a secret unless you click *reveal* or *edit*. Copying happens in the extension host. Every message from the dashboard is validated.
- No network access, no telemetry, no AI integration. Secrets are never logged.

Read [SECURITY.md](SECURITY.md) for the threat model, the known limits and how to report a vulnerability.

## Development

```bash
npm install
npm run build            # bundle to dist/ (esbuild)
npm run typecheck        # TypeScript (host + webview)
npm test                 # unit tests (vitest)
npm run test:integration # runs the extension inside a real VS Code (needs a display or xvfb-run)
npm run package          # creates passwdvault-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the release process.

## License

[MIT](LICENSE). Third-party components are listed in [NOTICE.md](NOTICE.md).
