import type { ItemType } from '../../shared/model';
import type { ImportedItem } from '../vault/VaultDocument';
import { csvObjects, parseCsv } from './csv';

export type ImportFormat = 'bitwardenCsv' | 'bitwardenJson' | 'keepassxcCsv' | 'browserCsv' | 'passwdvaultCsv';

export const IMPORT_FORMATS: { id: ImportFormat | 'kdbx'; label: string; detail: string; extensions: string[] }[] = [
  { id: 'kdbx', label: 'KeePass / KeePassXC database (.kdbx)', detail: 'Copies all entries and folders into a new folder', extensions: ['kdbx'] },
  { id: 'bitwardenJson', label: 'Bitwarden (unencrypted .json)', detail: 'Logins, secure notes, cards, folders, custom fields, TOTP', extensions: ['json'] },
  { id: 'bitwardenCsv', label: 'Bitwarden (.csv)', detail: 'Logins and secure notes', extensions: ['csv'] },
  { id: 'keepassxcCsv', label: 'KeePassXC (.csv)', detail: 'Group, Title, Username, Password, URL, Notes, TOTP', extensions: ['csv'] },
  { id: 'browserCsv', label: 'Chrome / Edge / Firefox / Safari (.csv)', detail: 'name/url/username/password exports', extensions: ['csv'] },
  { id: 'passwdvaultCsv', label: 'PasswdVault (.csv)', detail: 'CSV previously exported by PasswdVault', extensions: ['csv'] },
];

export class ImportError extends Error {}

const MAX_ITEMS = 100_000;

function blank(): ImportedItem {
  return { type: 'login', title: '', username: '', password: '', url: '', notes: '', folder: '', tags: [], favorite: false, totp: '', customFields: [] };
}

function pick(o: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) if (o[k] !== undefined && o[k] !== '') return o[k];
  return '';
}

function requireColumns(rows: string[][], ...anyOf: string[][]): void {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  for (const group of anyOf) {
    if (!group.some((c) => header.includes(c))) {
      throw new ImportError(`The CSV header does not look right: expected a column named ${group.map((g) => `"${g}"`).join(' or ')}.`);
    }
  }
}

function splitTags(v: string): string[] {
  return v.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
}

export function parseImport(format: ImportFormat, text: string): ImportedItem[] {
  let items: ImportedItem[];
  switch (format) {
    case 'bitwardenJson': items = parseBitwardenJson(text); break;
    case 'bitwardenCsv': items = parseBitwardenCsv(text); break;
    case 'keepassxcCsv': items = parseKeepassxcCsv(text); break;
    case 'browserCsv': items = parseBrowserCsv(text); break;
    case 'passwdvaultCsv': items = parsePasswdVaultCsv(text); break;
    default: throw new ImportError('Unsupported format');
  }
  if (items.length > MAX_ITEMS) throw new ImportError('Too many items in the file');
  return items;
}

export function parseBitwardenCsv(text: string): ImportedItem[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['name'], ['login_password', 'login_username']);
  return csvObjects(rows).map((o) => {
    const it = blank();
    it.type = o['type'] === 'note' ? 'note' : 'login';
    it.title = o['name'] ?? '';
    it.folder = o['folder'] ?? '';
    it.favorite = o['favorite'] === '1' || o['favorite']?.toLowerCase() === 'true';
    it.notes = o['notes'] ?? '';
    it.username = o['login_username'] ?? '';
    it.password = o['login_password'] ?? '';
    it.url = (o['login_uri'] ?? '').split(',')[0].trim();
    it.totp = o['login_totp'] ?? '';
    for (const line of (o['fields'] ?? '').split('\n')) {
      const idx = line.indexOf(': ');
      if (idx > 0) it.customFields.push({ name: line.slice(0, idx), value: line.slice(idx + 2), protected: false });
    }
    return it;
  });
}

interface BwItem {
  type?: number; name?: string; notes?: string | null; favorite?: boolean; folderId?: string | null;
  login?: { username?: string | null; password?: string | null; totp?: string | null; uris?: { uri?: string | null }[] | null } | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  fields?: { name?: string | null; value?: string | null; type?: number }[] | null;
}

export function parseBitwardenJson(text: string): ImportedItem[] {
  let data: { encrypted?: boolean; folders?: { id: string; name: string }[]; items?: BwItem[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('The file is not valid JSON.');
  }
  if (data.encrypted) throw new ImportError('Encrypted Bitwarden exports are not supported. Export as unencrypted JSON (and delete the file afterwards).');
  if (!Array.isArray(data.items)) throw new ImportError('This does not look like a Bitwarden JSON export.');
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  return data.items.map((bw) => {
    const it = blank();
    it.title = bw.name ?? '';
    it.notes = bw.notes ?? '';
    it.favorite = !!bw.favorite;
    it.folder = (bw.folderId && folders.get(bw.folderId)) || '';
    for (const f of bw.fields ?? []) {
      // type 1 = hidden field
      it.customFields.push({ name: f.name ?? 'Field', value: f.value ?? '', protected: f.type === 1 });
    }
    switch (bw.type) {
      case 1:
        it.type = 'login';
        it.username = bw.login?.username ?? '';
        it.password = bw.login?.password ?? '';
        it.totp = bw.login?.totp ?? '';
        it.url = bw.login?.uris?.[0]?.uri ?? '';
        for (const extra of (bw.login?.uris ?? []).slice(1)) {
          if (extra.uri) it.customFields.push({ name: 'URL', value: extra.uri, protected: false });
        }
        break;
      case 2:
        it.type = 'note';
        break;
      case 3: {
        const c = bw.card ?? {};
        it.type = 'card';
        it.username = c.cardholderName ?? '';
        it.customFields.unshift(
          { name: 'Card number', value: c.number ?? '', protected: true },
          { name: 'Expiration (MM/YY)', value: c.expMonth || c.expYear ? `${(c.expMonth ?? '').padStart(2, '0')}/${(c.expYear ?? '').slice(-2)}` : '', protected: false },
          { name: 'Security code', value: c.code ?? '', protected: true },
        );
        if (c.brand) it.customFields.push({ name: 'Brand', value: c.brand, protected: false });
        break;
      }
      case 4: {
        it.type = 'note';
        for (const [k, v] of Object.entries(bw.identity ?? {})) {
          if (v) it.customFields.push({ name: k, value: v, protected: /ssn|passport|license/i.test(k) });
        }
        break;
      }
      default:
        it.type = 'note';
    }
    return it;
  });
}

export function parseKeepassxcCsv(text: string): ImportedItem[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['title'], ['password']);
  return csvObjects(rows).map((o) => {
    const it = blank();
    const group = pick(o, 'group');
    // KeePassXC prefixes groups with the root group name ("Root/Folder").
    it.folder = group.includes('/') ? group.slice(group.indexOf('/') + 1) : '';
    it.title = pick(o, 'title');
    it.username = pick(o, 'username', 'user name');
    it.password = pick(o, 'password');
    it.url = pick(o, 'url');
    it.notes = pick(o, 'notes');
    it.totp = pick(o, 'totp');
    it.tags = splitTags(pick(o, 'tags'));
    if (!it.password && !it.username && !it.url && it.notes) it.type = 'note';
    return it;
  });
}

export function parseBrowserCsv(text: string): ImportedItem[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['url', 'website', 'origin'], ['password']);
  return csvObjects(rows).map((o) => {
    const it = blank();
    it.url = pick(o, 'url', 'website', 'origin');
    it.title = pick(o, 'name', 'title') || hostOf(it.url);
    it.username = pick(o, 'username', 'login', 'user');
    it.password = pick(o, 'password');
    it.notes = pick(o, 'note', 'notes');
    it.totp = pick(o, 'otpauth', 'totp');
    return it;
  });
}

export const PASSWDVAULT_CSV_HEADER = ['folder', 'favorite', 'type', 'name', 'username', 'password', 'url', 'notes', 'totp', 'tags', 'fields'];

export function parsePasswdVaultCsv(text: string): ImportedItem[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['name'], ['password'], ['type']);
  return csvObjects(rows).map((o) => {
    const it = blank();
    const t = o['type'] as ItemType;
    it.type = ['login', 'apiKey', 'token', 'sshKey', 'card', 'note'].includes(t) ? t : 'login';
    it.folder = o['folder'] ?? '';
    it.favorite = o['favorite'] === '1';
    it.title = o['name'] ?? '';
    it.username = o['username'] ?? '';
    it.password = o['password'] ?? '';
    it.url = o['url'] ?? '';
    it.notes = o['notes'] ?? '';
    it.totp = o['totp'] ?? '';
    it.tags = splitTags(o['tags'] ?? '');
    if (o['fields']) {
      try {
        const parsed = JSON.parse(o['fields']) as { name: string; value: string; protected: boolean }[];
        if (Array.isArray(parsed)) {
          for (const f of parsed) {
            if (f && typeof f.name === 'string' && typeof f.value === 'string') it.customFields.push({ name: f.name, value: f.value, protected: !!f.protected });
          }
        }
      } catch {
        it.customFields.push({ name: 'Fields (unparsed)', value: o['fields'], protected: true });
      }
    }
    return it;
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
