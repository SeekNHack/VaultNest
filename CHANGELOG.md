# Changelog

## 1.5.1 — 2026-10-27

- The auto-lock time is now stored inside each encrypted vault and changing it asks for the master password (*Vault settings → Auto-lock → Change…* or **VaultNest: Change Auto-Lock Time…**). It can no longer be changed from VS Code settings or by editing a file.
- Removed the `vaultnest.autoLock.minutes` setting. Vaults lock after 15 minutes without activity until you choose another time.

## 1.4.0 — 2026-10-27

- Vault settings: choose after how long each vault locks itself without activity (or use the global default). The setting can only be changed while the vault is unlocked; closing VS Code always locks every vault.
- Item editor: a new button next to *Generate* opens the generator in a dialog, to choose the length, character sets or a passphrase for that password only (the saved defaults are not changed).

## 1.3.1 — 2026-10-27

- Fixed the extension icon.

## 1.3.0 — 2026-10-27

First Marketplace release.

- Encrypted vaults in the open KDBX format (KDBX 4, Argon2id, AES-256): create, open, lock and unlock, several vaults, global or per workspace.
- Auto-lock on inactivity and, optionally, when the window loses focus; everything is locked on startup.
- Items: logins, API keys, tokens, SSH keys, cards and secure notes, with custom (hidden) fields, folders, tags, favorites, expiry dates and 2FA codes (TOTP) from the website's setup key.
- Dashboard with search, filters, item details and editor, password generator, password health report and vault settings.
- Sidebar tree, status bar indicator, quick search (`Ctrl+Alt+P`) and copy/insert commands.
- Password and passphrase generator using the system CSPRNG, with a complexity meter.
- Clipboard auto-clear, only if the clipboard still holds the copied value.
- Safe saving: atomic writes with verification, rotating encrypted backups, automatic merge of changes made by other apps or sync clients, and a recovery copy if a save fails.
- Import from KDBX files, password-manager JSON/CSV exports and browser CSV; export to KDBX and CSV.
