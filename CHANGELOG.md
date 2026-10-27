# Changelog

## 1.1.1 — 2026-10-27

- Published under the `hacknseek` Marketplace publisher (extension ID `hacknseek.passwdvault`).

## 1.1.0 — 2026-10-27

- **2FA from QR codes:** set up authenticator codes by scanning the screen (with a cancellable countdown), choosing an image file, pasting a screenshot, or dropping an image onto the 2FA field. The editor fills in an empty name or username from the QR code.
- **Google Authenticator export:** import every account from a *Transfer accounts* QR code as new items.
- New commands: *Add 2FA Account from QR Code…* and *Set Up 2FA from QR Code…* (in the item context menu).
- *With 2FA* filter in the dashboard, and a *Set up 2FA…* shortcut on items without codes.
- Security: the bundled XML parser (`@xmldom/xmldom`) is upgraded to 0.8.15, which fixes several advisories.
- README with screenshots.

## 1.0.0 — 2026-10-27

First release.

- Encrypted, KeePass-compatible vaults (KDBX 4, Argon2id, AES-256) — create, open, lock/unlock, multiple vaults, global or per-workspace.
- Auto-lock on inactivity and (optionally) when the window loses focus; everything locked on startup.
- Items: logins, API keys, tokens, SSH keys, cards, secure notes; custom (hidden) fields, folders, tags, favorites, expiry, TOTP.
- Dashboard with search, filters, item details/editor, password generator, password health report and vault settings.
- Sidebar tree, status bar indicator, quick search (`Ctrl+Alt+P`), copy/insert commands.
- Password & passphrase generator using the system CSPRNG; zxcvbn strength meter.
- Clipboard auto-clear (only if the clipboard still holds the copied secret).
- Crash-safe saving: atomic writes with verification, rotating encrypted backups, automatic merge of external changes (KeePassXC, sync clients), recovery copy on failure.
- Import: KDBX, Bitwarden (JSON/CSV), KeePassXC CSV, browser CSV, PasswdVault CSV. Export: KDBX, PasswdVault CSV, Bitwarden CSV.
