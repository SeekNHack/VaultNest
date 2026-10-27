import type { ImportedItem } from '../vault/VaultDocument';
import { toCsv } from './csv';
import { PASSWDVAULT_CSV_HEADER } from './importers';

/** Serialises items to the PasswdVault CSV format (UNENCRYPTED – contains plaintext secrets). */
export function exportPasswdVaultCsv(items: ImportedItem[]): string {
  const rows = [PASSWDVAULT_CSV_HEADER];
  for (const it of items) {
    rows.push([
      it.folder, it.favorite ? '1' : '', it.type, it.title, it.username, it.password, it.url, it.notes, it.totp,
      it.tags.join(','), it.customFields.length ? JSON.stringify(it.customFields) : '',
    ]);
  }
  return toCsv(rows);
}

/** Bitwarden-compatible CSV (logins and notes only; other types are exported as logins). */
export function exportBitwardenCsv(items: ImportedItem[]): string {
  const rows = [['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp']];
  for (const it of items) {
    rows.push([
      it.folder, it.favorite ? '1' : '', it.type === 'note' ? 'note' : 'login', it.title, it.notes,
      it.customFields.map((f) => `${f.name}: ${f.value}`).join('\n'), '0', it.url, it.username, it.password, it.totp,
    ]);
  }
  return toCsv(rows);
}
