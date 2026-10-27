# Architecture

VaultNest is split into three layers. Dependencies only point downwards.

```
┌──────────────────────────────────────────────────────────────┐
│ webview (browser, sandboxed)          src/webview/           │
│   dashboard UI · no secrets by default · RPC client          │
└──────────────▲───────────────────────────────────────────────┘
               │ postMessage (validated RPC + events)  src/shared/protocol.ts
┌──────────────┴───────────────────────────────────────────────┐
│ host (VS Code extension host)         src/host/, extension.ts│
│   VaultManager · commands · tree · status bar · dashboard    │
│   AutoLock · ClipboardService · import/export/vault flows    │
└──────────────▲───────────────────────────────────────────────┘
               │ plain TypeScript calls
┌──────────────┴───────────────────────────────────────────────┐
│ core (pure Node, no vscode import)    src/core/              │
│   VaultDocument · VaultSession · VaultStorage · argon2       │
│   generator · strength · totp · health · csv/importers       │
└──────────────────────────────────────────────────────────────┘
```

`src/shared/model.ts` holds the types shared by all layers (item types, summaries, inputs). Keeping `core` free of `vscode` imports lets the vault engine be unit-tested with plain Node (vitest).

## Core

| Module | Responsibility |
|---|---|
| `vault/argon2.ts` | Plugs hash-wasm's Argon2d/Argon2id into kdbxweb's crypto engine. |
| `vault/VaultDocument.ts` | Wraps a decrypted `kdbxweb.Kdbx`: entries CRUD, folders (KDBX groups), trash (KDBX recycle bin), favorites and item types (entry `CustomData`), TOTP (`otp` field, KeePassXC format; also reads KeePass 2.x `TimeOtp-*`), history, merge, import/export mapping, KDF and credential changes. It checks all input **before** changing anything. |
| `vault/VaultStorage.ts` | File I/O: KDBX signature check, SHA-256 fingerprint, atomic write (temp file → fsync → verify → rename → fsync dir), rotating backups. |
| `vault/VaultSession.ts` | Lifecycle of one vault file: create, unlock, lock, and a **serialised save queue**. Each save: detect external change → merge → backup if due → encrypt → write atomically, after decrypting the temp file again to verify it. Locking with unsaved changes writes an encrypted recovery copy. |
| `generator/` | Password and passphrase generation with `crypto.randomInt` (no modulo bias); EFF large wordlist. |
| `security/strength.ts` | Complexity estimate: length × log2 of the character sets used, as bits and a 0–4 score. |
| `security/totp.ts` | RFC 6238 TOTP (SHA-1/256/512), otpauth URI parsing, base32. |
| `health/health.ts` | Weak / reused / old / expired / insecure-URL detection. Reuse detection compares salted SHA-256 hashes, and strength results are cached by hash. |
| `io/` | RFC 4180 CSV, importers (Bitwarden JSON/CSV, KeePassXC CSV, browser CSV, VaultNest CSV), exporters. |

### KDBX mapping

| VaultNest | KDBX |
|---|---|
| Vault | Database file (`.kdbx`) |
| Folder | Group (the root group is "No folder") |
| Trash | Recycle bin group |
| Name / Username / Password / URL / Notes | Standard fields `Title`, `UserName`, `Password` (always protected), `URL`, `Notes` |
| Custom field (hidden) | Extra string field (protected when hidden) |
| TOTP | `otp` field with an `otpauth://` URI (KeePassXC convention) |
| Tags | Entry tags |
| Item type, favorite | Entry `CustomData`: `VaultNest.Type`, `VaultNest.Favorite` (KDBX 4 only) |
| Expiry | `Times.Expires` / `ExpiryTime` |
| Edit history | Entry history (limited by `HistoryMaxItems`, default 10) |

Entries created by other clients have no `VaultNest.Type`. Their type is inferred: an entry with only notes is a secure note, anything else is a login.

## Host

- **`VaultManager`** — registry of vault references (global ones in `globalState`, workspace ones in `workspaceState`; paths only, never secrets), lazily created `VaultSession`s, unlock prompts (3 attempts), lock/lockAll, `mutate()` (change + save + event), health-report cache, and conflict prompts. It fires `onDidChange` events (`registry`, `lock`, `content`) that the tree, status bar, context keys and dashboard listen to.
- **`Actions`** — operations shared by commands and the dashboard (copy, open URL with a scheme allow-list, delete/restore with confirmation, folders, generator).
- **`commands.ts`** — every contributed command. Commands accept a tree node, a `{vaultId, entryId}` reference (from the dashboard or other commands) or nothing; with nothing they ask through quick picks.
- **`services/AutoLock`** — inactivity timer driven by editor, terminal and window events plus every VaultNest interaction; optional lock when the window loses focus.
- **`services/ClipboardService`** — copy + delayed clear if unchanged (compares hashes).
- **`services/vaultFlows` / `dataFlows`** — guided multi-step flows (create/open vault, change master password, import, export).
- **`views/VaultTreeProvider`**, **`views/StatusBar`**, **`views/DashboardPanel`** (+ `rpcValidation`).

## Webview ↔ host protocol

`src/shared/protocol.ts` defines a typed RPC: `{kind:'request', id, method, params}` → `{kind:'response', id, ok, result|error}`, plus host-pushed events (`state`, `navigate`, `locked`, `toast`).

- `state` carries `DashboardState`: vault infos, folders, entry **summaries** (title, username, URL, tags, flags, health issues), tags and UI preferences. **No secret values.**
- Secrets are fetched only by `reveal` (one field, after a user action). Copying uses `copyField`, so the value never enters the webview.
- In the editor, protected fields start as `{keep: true}`. Unless the user reveals or retypes a value, the host keeps the stored value and the webview never sees it.
- `rpcValidation.ts` checks every request against a strict schema (types, lengths, enums, no unknown properties) before any handler runs.

## Webview

Plain TypeScript with a small DOM helper (`dom.ts`), and no framework, to keep the bundle small and easy to audit. Text is always inserted through `textContent`/properties. The shell (top bar, search box) persists across renders, so focus and typed text survive state pushes. The editor is never re-rendered by a background state update, so input is not lost. The webview keeps UI state (selected item, filter, sort) with `vscode.setState`; it contains no secrets.

## Build & packaging

esbuild produces two bundles:

- `dist/extension.js` — CommonJS for Node 20. It includes kdbxweb, @xmldom/xmldom, and hash-wasm (WASM inlined). Its only external module is `vscode`, so the packaged extension needs no `node_modules`.
- `dist/webview.js` + `dist/webview.css` — IIFE for the browser; codicons are copied to `dist/media/`.

## Decisions

- **kdbxweb + KDBX 4** instead of a custom format: interoperability with the KeePass ecosystem, proven crypto, built-in merge. KDBX 4 brings Argon2 and entry `CustomData`.
- **hash-wasm for Argon2**: pure WASM, so there are no native modules to rebuild for each VS Code/Electron version and platform.
- **Native input boxes for the master password** instead of a webview form: the master password never crosses the webview boundary, and VS Code's input box is the platform's trusted UI.
- **Save after every change** (Bitwarden-like), serialised and verified. Each save costs one KDF run plus one more for verification. With the default parameters this takes well under a second, and it is the price of never leaving a corrupt file.
- **Merge instead of overwrite** when the file changed on disk. This makes "sync" through any file-sync service work today, and it is the basis for a future built-in sync (WebDAV/Git/cloud storage providers) — see *Future work*.

## Future work

- Built-in sync providers (WebDAV, Git, S3) on top of `VaultSession.syncFromDisk`/`merge`.
- Attachments (view/add/download) — KDBX binaries are already kept.
- Browse and restore an item's history.
- Localisation (`package.nls.*.json` + `vscode.l10n`).
- Optional OS-keychain "quick unlock" (with the security trade-offs this implies).
