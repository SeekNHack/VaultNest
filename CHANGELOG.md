# Changelog

## 1.2.2 — 2026-10-27

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
