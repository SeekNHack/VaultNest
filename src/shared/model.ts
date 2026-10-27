/**
 * Data model shared by the extension host and the webview.
 *
 * IMPORTANT: nothing in these summary/detail shapes carries a secret value by
 * default. Protected fields (passwords, secret custom fields, TOTP seeds) are
 * only described by metadata; their plaintext crosses the webview boundary only
 * through an explicit, user-initiated `reveal` request.
 */

export const ITEM_TYPES = ['login', 'apiKey', 'token', 'sshKey', 'card', 'note'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && (ITEM_TYPES as readonly string[]).includes(value);
}

/** Labels used for the standard KDBX fields depending on the item type. */
export interface ItemTypeInfo {
  label: string;
  plural: string;
  icon: string; // codicon name
  usernameLabel: string | null;
  passwordLabel: string | null;
  urlLabel: string | null;
  /** Custom fields pre-populated when creating a new item of this type. */
  templateFields: { name: string; protected: boolean; multiline?: boolean }[];
}

export const ITEM_TYPE_INFO: Record<ItemType, ItemTypeInfo> = {
  login: {
    label: 'Login', plural: 'Logins', icon: 'globe',
    usernameLabel: 'Username', passwordLabel: 'Password', urlLabel: 'Website',
    templateFields: [],
  },
  apiKey: {
    label: 'API Key', plural: 'API Keys', icon: 'key',
    usernameLabel: 'Key ID / Client ID', passwordLabel: 'Secret key', urlLabel: 'Endpoint / Console URL',
    templateFields: [],
  },
  token: {
    label: 'Token', plural: 'Tokens', icon: 'shield',
    usernameLabel: 'Account', passwordLabel: 'Token', urlLabel: 'Service URL',
    templateFields: [],
  },
  sshKey: {
    label: 'SSH Key', plural: 'SSH Keys', icon: 'terminal',
    usernameLabel: 'User@Host', passwordLabel: 'Key passphrase', urlLabel: null,
    templateFields: [
      { name: 'Private key', protected: true, multiline: true },
      { name: 'Public key', protected: false, multiline: true },
    ],
  },
  card: {
    label: 'Card', plural: 'Cards', icon: 'credit-card',
    usernameLabel: 'Cardholder name', passwordLabel: 'PIN', urlLabel: null,
    templateFields: [
      { name: 'Card number', protected: true },
      { name: 'Expiration (MM/YY)', protected: false },
      { name: 'Security code', protected: true },
    ],
  },
  note: {
    label: 'Secure Note', plural: 'Secure Notes', icon: 'note',
    usernameLabel: null, passwordLabel: null, urlLabel: null,
    templateFields: [],
  },
};

export type HealthIssue = 'weak' | 'reused' | 'old' | 'expired' | 'insecureUrl';

export interface VaultInfo {
  id: string;
  name: string;
  path: string;
  scope: 'global' | 'workspace';
  locked: boolean;
  /** Only present when unlocked. */
  details?: {
    kdbxVersion: string;
    kdf: string;
    kdfMemoryMiB?: number;
    kdfIterations?: number;
    cipher: string;
    hasKeyFile: boolean;
    entryCount: number;
    description: string;
    lastSaved?: number;
  };
  keyFilePath?: string;
  /** Per-vault inactivity timeout in minutes (0 = never); unset uses the global setting. */
  autoLockMinutes?: number;
}

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  isTrash: boolean;
  isRoot: boolean;
  entryCount: number;
}

export interface EntrySummary {
  id: string;
  vaultId: string;
  type: ItemType;
  title: string;
  username: string;
  url: string;
  tags: string[];
  favorite: boolean;
  folderId: string;
  folderPath: string;
  hasPassword: boolean;
  hasTotp: boolean;
  trashed: boolean;
  created: number;
  modified: number;
  expires: number | null;
  /** Names of the non-protected custom fields (for search). */
  fieldNames: string[];
  issues: HealthIssue[];
}

export interface CustomFieldView {
  name: string;
  protected: boolean;
  /** Only present for non-protected fields. */
  value?: string;
  /** True if a protected field contains a non-empty value. */
  hasValue: boolean;
  multiline: boolean;
}

export interface EntryDetail extends EntrySummary {
  notes: string;
  passwordLength: number;
  customFields: CustomFieldView[];
  historyCount: number;
  attachments: { name: string; size: number }[];
}

/** A value that the user did not change in the editor keeps its previous content. */
export interface KeepValue { keep: true }
export type FieldValueInput = string | KeepValue;

export interface CustomFieldInput {
  name: string;
  /** Name of the field before editing (for renames of protected fields with keep). */
  originalName?: string;
  value: FieldValueInput;
  protected: boolean;
}

export interface EntryInput {
  type: ItemType;
  title: string;
  username: string;
  password: FieldValueInput;
  url: string;
  notes: string;
  tags: string[];
  favorite: boolean;
  folderId: string | null;
  expires: number | null;
  /** otpauth:// URI or base32 secret; KeepValue keeps the existing one. */
  totp: FieldValueInput;
  customFields: CustomFieldInput[];
}

export interface GeneratorOptions {
  mode: 'password' | 'passphrase';
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  minDigits: number;
  minSymbols: number;
  avoidAmbiguous: boolean;
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  mode: 'password',
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  minDigits: 1,
  minSymbols: 1,
  avoidAmbiguous: false,
  words: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
};

export interface StrengthResult {
  /** 0 (very weak) .. 4 (strong) */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  /** Estimated complexity in bits (the generator's exact entropy for generated values). */
  entropyBits: number;
}

export interface HealthReport {
  vaultId: string;
  generatedAt: number;
  total: number;
  counts: Record<HealthIssue, number>;
  items: { id: string; issues: HealthIssue[]; score?: number; reusedCount?: number }[];
}
