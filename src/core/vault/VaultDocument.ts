import * as kdbxweb from 'kdbxweb';
import {
  CustomFieldInput, CustomFieldView, EntryDetail, EntryInput, EntrySummary, FieldValueInput, FolderNode,
  ITEM_TYPE_INFO, ItemType, isItemType,
} from '../../shared/model';
import { normalizeTotpInput, parseKeePassNativeTotp, parseTotp, TotpParams } from '../security/totp';
import { installArgon2 } from './argon2';

installArgon2();

const { ProtectedValue } = kdbxweb;
type ProtectedValue = kdbxweb.ProtectedValue;
type KdbxEntry = kdbxweb.KdbxEntry;
type KdbxGroup = kdbxweb.KdbxGroup;

/** Custom data keys stored on entries (KDBX 4 `CustomData`, ignored by other clients). */
export const CUSTOM_DATA = {
  type: 'PasswdManager.Type',
  favorite: 'PasswdManager.Favorite',
} as const;

/** Keys written by versions published as PasswdVault; still read, and replaced on the next write. */
const LEGACY_CUSTOM_DATA: Record<string, string> = {
  [CUSTOM_DATA.type]: 'PasswdVault.Type',
  [CUSTOM_DATA.favorite]: 'PasswdVault.Favorite',
};

/** Standard KDBX field names. */
export const STD_FIELDS = {
  title: 'Title',
  username: 'UserName',
  password: 'Password',
  url: 'URL',
  notes: 'Notes',
} as const;
const STANDARD = new Set<string>(Object.values(STD_FIELDS));

/** KeePassXC stores TOTP as an otpauth URI in this field. */
export const TOTP_FIELD = 'otp';
const KEEPASS_TOTP_PREFIX = 'TimeOtp-';

const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024 * 1024; // 1 MiB per field is plenty (SSH keys, certificates...)
const MAX_TAGS = 64;

export interface KdfSettings {
  memoryMiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF: KdfSettings = { memoryMiB: 64, iterations: 3, parallelism: 2 };

export class VaultError extends Error {
  constructor(message: string, readonly code: 'NotFound' | 'Invalid' | 'Unsupported' = 'Invalid') {
    super(message);
  }
}

export interface CredentialsInput {
  password: ProtectedValue;
  keyFile?: Uint8Array | null;
}

export async function makeCredentials(input: CredentialsInput): Promise<kdbxweb.KdbxCredentials> {
  const creds = new kdbxweb.KdbxCredentials(input.password, input.keyFile ?? null);
  await creds.ready;
  return creds;
}

/** Item imported from external sources (CSV/JSON) before being added to a vault. */
export interface ImportedItem {
  type: ItemType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  folder: string;
  tags: string[];
  favorite: boolean;
  totp: string;
  customFields: { name: string; value: string; protected: boolean }[];
}

function fieldText(v: kdbxweb.KdbxEntryField | undefined): string {
  if (v === undefined) return '';
  return v instanceof ProtectedValue ? v.getText() : v;
}

function isTotpField(name: string): boolean {
  return name === TOTP_FIELD || name.startsWith(KEEPASS_TOTP_PREFIX);
}

function time(d: Date | undefined): number {
  return d ? d.getTime() : 0;
}

function clampString(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw new VaultError(`${what} must be a string`);
  if (value.length > max) throw new VaultError(`${what} is too long`);
  return value;
}

/**
 * High-level, UI-agnostic wrapper around a decrypted KDBX database.
 * All mutations happen in memory; persistence is handled by {@link VaultStorage}.
 */
export class VaultDocument {
  private constructor(public readonly db: kdbxweb.Kdbx) {}

  // ---------------------------------------------------------------- lifecycle

  static create(name: string, credentials: kdbxweb.KdbxCredentials, kdf: KdfSettings = DEFAULT_KDF): VaultDocument {
    const db = kdbxweb.Kdbx.create(credentials, name);
    db.setVersion(4);
    const doc = new VaultDocument(db);
    doc.setKdf(kdf);
    db.meta.historyMaxItems = 10;
    db.getDefaultGroup().name = name;
    return doc;
  }

  static async load(bytes: Uint8Array, credentials: kdbxweb.KdbxCredentials): Promise<VaultDocument> {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const db = await kdbxweb.Kdbx.load(ab, credentials);
    return new VaultDocument(db);
  }

  async save(): Promise<Uint8Array> {
    this.db.cleanup({ historyRules: true });
    return new Uint8Array(await this.db.save());
  }

  /** Sets Argon2id parameters used on the next save. Upgrades KDBX 3.1 files to KDBX 4. */
  setKdf(kdf: KdfSettings): void {
    if (this.db.versionMajor < 4) this.db.setVersion(4);
    this.db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    const p = this.db.header.kdfParameters!;
    const { ValueType } = kdbxweb.VarDictionary;
    p.set('M', ValueType.UInt64, kdbxweb.Int64.from(Math.round(kdf.memoryMiB) * 1024 * 1024));
    p.set('I', ValueType.UInt64, kdbxweb.Int64.from(Math.round(kdf.iterations)));
    p.set('P', ValueType.UInt32, Math.round(kdf.parallelism));
  }

  async changeCredentials(input: CredentialsInput, kdf?: KdfSettings): Promise<void> {
    await this.db.credentials.setPassword(input.password);
    await this.db.credentials.setKeyFile(input.keyFile ?? null);
    this.db.meta.keyChanged = new Date();
    if (kdf) this.setKdf(kdf);
  }

  upgradeFormat(kdf: KdfSettings): void {
    this.db.upgrade();
    this.setKdf(kdf);
  }

  /** Merges changes from another copy of the same database (e.g. modified on disk by KeePassXC). */
  merge(remote: VaultDocument): void {
    this.db.merge(remote.db);
  }

  // ---------------------------------------------------------------- metadata

  get name(): string {
    return this.db.meta.name ?? 'Vault';
  }
  set name(value: string) {
    this.db.meta.name = clampString(value.trim(), 200, 'Name') || 'Vault';
  }
  get description(): string {
    return this.db.meta.desc ?? '';
  }
  set description(value: string) {
    this.db.meta.desc = clampString(value, 10_000, 'Description');
  }

  get formatInfo(): { kdbxVersion: string; kdf: string; kdfMemoryMiB?: number; kdfIterations?: number; cipher: string; hasKeyFile: boolean } {
    const h = this.db.header;
    let kdf = 'AES-KDF';
    let kdfMemoryMiB: number | undefined;
    let kdfIterations: number | undefined;
    const params = h.kdfParameters;
    const uuid = params?.get('$UUID');
    if (uuid instanceof ArrayBuffer) {
      const id = kdbxweb.ByteUtils.bytesToBase64(uuid);
      if (id === kdbxweb.Consts.KdfId.Argon2id) kdf = 'Argon2id';
      else if (id === kdbxweb.Consts.KdfId.Argon2d) kdf = 'Argon2d';
      if (kdf.startsWith('Argon2')) {
        const m = params!.get('M');
        const i = params!.get('I');
        kdfMemoryMiB = (m instanceof kdbxweb.Int64 ? m.value : Number(m)) / 1024 / 1024;
        kdfIterations = i instanceof kdbxweb.Int64 ? i.value : Number(i);
      }
    }
    const cipherId = h.dataCipherUuid?.toString();
    const cipher = cipherId === kdbxweb.Consts.CipherId.ChaCha20 ? 'ChaCha20' : 'AES-256';
    return {
      kdbxVersion: `${this.db.versionMajor}.${this.db.versionMinor}`,
      kdf, kdfMemoryMiB, kdfIterations, cipher,
      hasKeyFile: !!this.db.credentials.keyFileHash,
    };
  }

  // ---------------------------------------------------------------- groups

  get root(): KdbxGroup {
    return this.db.getDefaultGroup();
  }

  get trashGroup(): KdbxGroup | undefined {
    const id = this.db.meta.recycleBinUuid;
    return id ? this.db.getGroup(id) : undefined;
  }

  private ensureTrash(): KdbxGroup {
    if (!this.db.meta.recycleBinEnabled) this.db.meta.recycleBinEnabled = true;
    this.db.createRecycleBin();
    return this.trashGroup!;
  }

  isInTrash(item: KdbxGroup | KdbxEntry): boolean {
    const trash = this.trashGroup;
    if (!trash) return false;
    let g: KdbxGroup | undefined = item instanceof kdbxweb.KdbxGroup ? item : item.parentGroup;
    while (g) {
      if (g === trash) return true;
      g = g.parentGroup;
    }
    return false;
  }

  private getGroupOrThrow(id: string | null | undefined): KdbxGroup {
    if (!id) return this.root;
    const g = this.db.getGroup(id);
    if (!g) throw new VaultError('Folder not found', 'NotFound');
    return g;
  }

  folderPath(group: KdbxGroup | undefined): string {
    const parts: string[] = [];
    let g = group;
    while (g && g !== this.root) {
      parts.unshift(g.name ?? '');
      g = g.parentGroup;
    }
    return parts.join(' / ');
  }

  listFolders(): FolderNode[] {
    const out: FolderNode[] = [];
    const trash = this.trashGroup;
    const walk = (g: KdbxGroup, depth: number) => {
      const isRoot = g === this.root;
      out.push({
        id: g.uuid.id,
        name: isRoot ? this.name : (g.name ?? ''),
        parentId: isRoot ? null : (g.parentGroup?.uuid.id ?? null),
        depth,
        isTrash: g === trash,
        isRoot,
        entryCount: g.entries.length,
      });
      const children = [...g.groups].sort((a, b) => (a === trash ? 1 : b === trash ? -1 : (a.name ?? '').localeCompare(b.name ?? '')));
      for (const c of children) walk(c, depth + 1);
    };
    walk(this.root, 0);
    return out;
  }

  createFolder(name: string, parentId: string | null): string {
    const clean = clampString(name.trim(), 200, 'Folder name');
    if (!clean) throw new VaultError('Folder name cannot be empty');
    const parent = this.getGroupOrThrow(parentId);
    if (this.isInTrash(parent)) throw new VaultError('Cannot create folders inside the trash');
    return this.db.createGroup(parent, clean).uuid.id;
  }

  renameFolder(id: string, name: string): void {
    const g = this.getGroupOrThrow(id);
    const clean = clampString(name.trim(), 200, 'Folder name');
    if (!clean) throw new VaultError('Folder name cannot be empty');
    if (g === this.root) {
      this.name = clean;
      g.name = clean;
    } else {
      g.name = clean;
    }
    g.times.update();
  }

  /** Moves a folder (and its content) to the trash, or deletes it permanently if already there. */
  deleteFolder(id: string): void {
    const g = this.getGroupOrThrow(id);
    if (g === this.root || g === this.trashGroup) throw new VaultError('This folder cannot be deleted');
    if (this.isInTrash(g)) this.db.move(g, null);
    else this.db.move(g, this.ensureTrash());
  }

  // ---------------------------------------------------------------- entries

  *allEntries(includeTrash = true): Generator<KdbxEntry> {
    for (const e of this.root.allEntries()) {
      if (includeTrash || !this.isInTrash(e)) yield e;
    }
  }

  findEntry(id: string): KdbxEntry {
    for (const e of this.root.allEntries()) {
      if (e.uuid.id === id) return e;
    }
    throw new VaultError('Item not found', 'NotFound');
  }

  entryType(e: KdbxEntry): ItemType {
    const t = this.getCustomData(e, CUSTOM_DATA.type);
    if (isItemType(t)) return t;
    // Infer a sensible type for entries created by other KeePass clients.
    const hasCreds = !!fieldText(e.fields.get(STD_FIELDS.password)) || !!fieldText(e.fields.get(STD_FIELDS.username)) || !!fieldText(e.fields.get(STD_FIELDS.url));
    if (!hasCreds && fieldText(e.fields.get(STD_FIELDS.notes))) return 'note';
    return 'login';
  }

  private setCustomData(e: KdbxEntry, key: string, value: string | undefined): void {
    if (this.db.versionMajor < 4) return; // KDBX 3.1 has no entry CustomData
    if (!e.customData) e.customData = new Map();
    e.customData.delete(LEGACY_CUSTOM_DATA[key]);
    if (value === undefined) e.customData.delete(key);
    else e.customData.set(key, { value, lastModified: new Date() });
  }

  private getCustomData(e: KdbxEntry, key: string): string | undefined {
    return (e.customData?.get(key) ?? e.customData?.get(LEGACY_CUSTOM_DATA[key]))?.value;
  }

  isFavorite(e: KdbxEntry): boolean {
    return this.getCustomData(e, CUSTOM_DATA.favorite) === 'true';
  }

  private totpParams(e: KdbxEntry): TotpParams | undefined {
    const otp = fieldText(e.fields.get(TOTP_FIELD));
    if (otp) return parseTotp(otp);
    const native = new Map<string, string>();
    for (const [k, v] of e.fields) if (k.startsWith(KEEPASS_TOTP_PREFIX)) native.set(k, fieldText(v));
    return native.size ? parseKeePassNativeTotp(native) : undefined;
  }

  getTotpParams(id: string): TotpParams | undefined {
    try {
      return this.totpParams(this.findEntry(id));
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError('The one-time password configuration of this item is invalid');
    }
  }

  summarize(e: KdbxEntry): EntrySummary {
    const fieldNames: string[] = [];
    for (const [k, v] of e.fields) {
      if (!STANDARD.has(k) && !isTotpField(k) && !(v instanceof ProtectedValue)) fieldNames.push(k);
    }
    const pw = e.fields.get(STD_FIELDS.password);
    const hasTotp = e.fields.has(TOTP_FIELD) || e.fields.has('TimeOtp-Secret-Base32') || e.fields.has('TimeOtp-Secret')
      || e.fields.has('TimeOtp-Secret-Hex') || e.fields.has('TimeOtp-Secret-Base64');
    return {
      id: e.uuid.id,
      vaultId: '',
      type: this.entryType(e),
      title: fieldText(e.fields.get(STD_FIELDS.title)),
      username: fieldText(e.fields.get(STD_FIELDS.username)),
      url: fieldText(e.fields.get(STD_FIELDS.url)),
      tags: [...e.tags],
      favorite: this.isFavorite(e),
      folderId: e.parentGroup?.uuid.id ?? this.root.uuid.id,
      folderPath: this.folderPath(e.parentGroup),
      hasPassword: pw instanceof ProtectedValue ? pw.byteLength > 0 : !!pw,
      hasTotp,
      trashed: this.isInTrash(e),
      created: time(e.times.creationTime),
      modified: time(e.times.lastModTime),
      expires: e.times.expires && e.times.expiryTime ? e.times.expiryTime.getTime() : null,
      fieldNames,
      issues: [],
    };
  }

  listEntries(): EntrySummary[] {
    return [...this.allEntries()].map((e) => this.summarize(e));
  }

  getEntry(id: string): EntryDetail {
    const e = this.findEntry(id);
    const type = this.entryType(e);
    const multilineTemplate = new Set(ITEM_TYPE_INFO[type].templateFields.filter((f) => f.multiline).map((f) => f.name));
    const customFields: CustomFieldView[] = [];
    for (const [name, v] of e.fields) {
      if (STANDARD.has(name) || isTotpField(name)) continue;
      if (v instanceof ProtectedValue) {
        customFields.push({ name, protected: true, hasValue: v.byteLength > 0, multiline: multilineTemplate.has(name) });
      } else {
        customFields.push({ name, protected: false, value: v, hasValue: v.length > 0, multiline: multilineTemplate.has(name) || v.includes('\n') });
      }
    }
    const pw = e.fields.get(STD_FIELDS.password);
    const attachments = [...e.binaries.entries()].map(([name, b]) => {
      const data: kdbxweb.KdbxBinary = b instanceof ProtectedValue || b instanceof ArrayBuffer ? b : b.value;
      return { name, size: data.byteLength };
    });
    return {
      ...this.summarize(e),
      notes: fieldText(e.fields.get(STD_FIELDS.notes)),
      passwordLength: pw instanceof ProtectedValue ? pw.getText().length : (pw ?? '').length,
      customFields,
      historyCount: e.history.length,
      attachments,
    };
  }

  /**
   * Returns the plaintext of a single field. `field` is a KDBX field name
   * (e.g. `Password`, a custom field name, or `otp`).
   */
  revealField(id: string, field: string): string {
    const e = this.findEntry(id);
    const v = e.fields.get(field);
    if (v === undefined) throw new VaultError('Field not found', 'NotFound');
    return fieldText(v);
  }

  /** Iterates over passwords of active (non-trashed) entries, for health analysis. */
  *passwords(): Generator<{ id: string; password: ProtectedValue | string; modified: number; expires: number | null; url: string }> {
    for (const e of this.allEntries(false)) {
      const pw = e.fields.get(STD_FIELDS.password);
      if (!pw || (pw instanceof ProtectedValue ? pw.byteLength === 0 : pw === '')) continue;
      yield {
        id: e.uuid.id,
        password: pw,
        modified: time(e.times.lastModTime),
        expires: e.times.expires && e.times.expiryTime ? e.times.expiryTime.getTime() : null,
        url: fieldText(e.fields.get(STD_FIELDS.url)),
      };
    }
  }

  private static resolveValue(input: FieldValueInput, previous: kdbxweb.KdbxEntryField | undefined, what: string): string | ProtectedValue | undefined {
    if (typeof input === 'object' && input !== null && input.keep === true) return previous;
    return clampString(input, MAX_FIELD_VALUE, what);
  }

  private static protect(value: string | ProtectedValue | undefined, protect: boolean): kdbxweb.KdbxEntryField {
    if (value === undefined) return protect ? ProtectedValue.fromString('') : '';
    if (protect) return value instanceof ProtectedValue ? value : ProtectedValue.fromString(value);
    return value instanceof ProtectedValue ? value.getText() : value;
  }

  private static validateCustomFields(fields: CustomFieldInput[]): void {
    const seen = new Set<string>();
    for (const f of fields) {
      const name = f.name.trim();
      if (!name) throw new VaultError('Custom field names cannot be empty');
      if (name.length > MAX_FIELD_NAME) throw new VaultError('Custom field name is too long');
      if (STANDARD.has(name) || isTotpField(name)) throw new VaultError(`"${name}" is a reserved field name`);
      if (seen.has(name)) throw new VaultError(`Duplicate custom field "${name}"`);
      seen.add(name);
    }
  }

  /** Creates (entryId = null) or updates an entry. Returns the entry id. */
  saveEntry(entryId: string | null, input: EntryInput): string {
    if (!isItemType(input.type)) throw new VaultError('Invalid item type');
    const title = clampString(input.title, 4096, 'Name').trim();
    if (!title) throw new VaultError('Name is required');
    VaultDocument.validateCustomFields(input.customFields);
    const tags = [...new Set(input.tags.map((t) => clampString(t, 200, 'Tag').trim()).filter(Boolean))];
    if (tags.length > MAX_TAGS) throw new VaultError('Too many tags');

    if (input.expires !== null && input.expires !== undefined && !Number.isFinite(input.expires)) throw new VaultError('Invalid expiry date');
    const keepTotp = typeof input.totp === 'object' && input.totp?.keep === true;
    let totpUri = '';
    if (!keepTotp) {
      const totp = clampString(input.totp, 4096, 'TOTP').trim();
      try {
        totpUri = totp ? normalizeTotpInput(totp, title) : '';
      } catch (err) {
        throw new VaultError(`Invalid authenticator key: ${(err as Error).message}`);
      }
    }
    for (const f of input.customFields) {
      if (typeof f.value === 'string') clampString(f.value, MAX_FIELD_VALUE, `Field "${f.name}"`);
    }
    clampString(input.username, 4096, 'Username');
    clampString(input.url, 8192, 'URL');
    clampString(input.notes, MAX_FIELD_VALUE, 'Notes');
    if (typeof input.password === 'string') clampString(input.password, MAX_FIELD_VALUE, 'Password');

    const isNew = entryId === null;
    const existing = isNew ? undefined : this.findEntry(entryId);
    if (existing && this.isInTrash(existing)) throw new VaultError('Restore the item before editing it');
    const moveTarget = isNew || input.folderId ? this.getGroupOrThrow(input.folderId) : undefined;
    if (moveTarget && this.isInTrash(moveTarget)) throw new VaultError('Items cannot be saved into the trash');

    let entry: KdbxEntry;
    if (existing) {
      entry = existing;
      entry.pushHistory();
    } else {
      entry = this.db.createEntry(moveTarget!);
    }
    const prev = new Map(entry.fields);
    const fields = new Map<string, kdbxweb.KdbxEntryField>();
    const mp = this.db.meta.memoryProtection;
    fields.set(STD_FIELDS.title, VaultDocument.protect(title, !!mp.title));
    fields.set(STD_FIELDS.username, VaultDocument.protect(clampString(input.username, 4096, 'Username'), !!mp.userName));
    fields.set(STD_FIELDS.password, VaultDocument.protect(VaultDocument.resolveValue(input.password, prev.get(STD_FIELDS.password), 'Password'), true));
    fields.set(STD_FIELDS.url, VaultDocument.protect(clampString(input.url, 8192, 'URL').trim(), !!mp.url));
    fields.set(STD_FIELDS.notes, VaultDocument.protect(clampString(input.notes, MAX_FIELD_VALUE, 'Notes'), !!mp.notes));

    for (const f of input.customFields) {
      const name = f.name.trim();
      const previous = prev.get(f.originalName ?? name) ?? prev.get(name);
      fields.set(name, VaultDocument.protect(VaultDocument.resolveValue(f.value, previous, `Field "${name}"`), !!f.protected));
    }

    // TOTP: keep previous (either format), remove, or replace with an otpauth URI.
    if (keepTotp) {
      for (const [k, v] of prev) if (isTotpField(k)) fields.set(k, v);
    } else if (totpUri) {
      fields.set(TOTP_FIELD, ProtectedValue.fromString(totpUri));
    }

    entry.fields = fields;
    entry.tags = tags;
    this.setCustomData(entry, CUSTOM_DATA.type, input.type);
    this.setCustomData(entry, CUSTOM_DATA.favorite, input.favorite ? 'true' : undefined);
    if (input.expires !== null && input.expires !== undefined) {
      entry.times.expires = true;
      entry.times.expiryTime = new Date(input.expires);
    } else {
      entry.times.expires = false;
    }
    if (moveTarget && moveTarget !== entry.parentGroup) this.db.move(entry, moveTarget);
    entry.times.update();
    return entry.uuid.id;
  }

  setFavorite(id: string, favorite: boolean): void {
    const e = this.findEntry(id);
    this.setCustomData(e, CUSTOM_DATA.favorite, favorite ? 'true' : undefined);
    e.times.update();
  }

  moveEntry(id: string, folderId: string): void {
    const e = this.findEntry(id);
    const target = this.getGroupOrThrow(folderId);
    if (this.isInTrash(target)) throw new VaultError('Use delete to move items to the trash');
    this.db.move(e, target);
  }

  /** Moves an entry to the trash; deletes it permanently if it already is in the trash. Returns true if permanently deleted. */
  deleteEntry(id: string): boolean {
    const e = this.findEntry(id);
    if (this.isInTrash(e)) {
      this.db.move(e, null);
      return true;
    }
    this.db.move(e, this.ensureTrash());
    return false;
  }

  restoreEntry(id: string): void {
    const e = this.findEntry(id);
    if (!this.isInTrash(e)) return;
    let target = e.previousParentGroup ? this.db.getGroup(e.previousParentGroup) : undefined;
    if (!target || this.isInTrash(target)) target = this.root;
    this.db.move(e, target);
  }

  emptyTrash(): number {
    const trash = this.trashGroup;
    if (!trash) return 0;
    const count = [...trash.allEntries()].length;
    for (const g of [...trash.groups]) this.db.move(g, null);
    for (const e of [...trash.entries]) this.db.move(e, null);
    return count;
  }

  allTags(): string[] {
    const tags = new Set<string>();
    for (const e of this.allEntries(false)) for (const t of e.tags) tags.add(t);
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  // ---------------------------------------------------------------- import

  /** Copies every entry/folder of another vault into a new folder of this vault. */
  importVault(other: VaultDocument, folderName: string): number {
    const target = this.db.createGroup(this.root, folderName);
    let count = 0;
    const copy = (src: KdbxGroup, dst: KdbxGroup) => {
      for (const e of src.entries) {
        const copied = this.db.importEntry(e, dst, other.db);
        copied.uuid = kdbxweb.KdbxUuid.random(); // avoid uuid clashes with existing entries
        count++;
      }
      for (const g of src.groups) {
        if (g === other.trashGroup) continue;
        copy(g, this.db.createGroup(dst, g.name ?? 'Folder'));
      }
    };
    copy(other.root, target);
    return count;
  }

  importItems(items: ImportedItem[], folderName: string): number {
    const base = this.db.createGroup(this.root, folderName);
    const folders = new Map<string, KdbxGroup>([['', base]]);
    const folderFor = (path: string): KdbxGroup => {
      const clean = path.split('/').map((p) => p.trim()).filter(Boolean).join('/');
      let g = folders.get(clean);
      if (g) return g;
      const idx = clean.lastIndexOf('/');
      const parent = folderFor(idx < 0 ? '' : clean.slice(0, idx));
      g = this.db.createGroup(parent, idx < 0 ? clean : clean.slice(idx + 1));
      folders.set(clean, g);
      return g;
    };
    let count = 0;
    for (const item of items) {
      const group = folderFor(item.folder);
      const fields: CustomFieldInput[] = [];
      const names = new Set<string>();
      for (const f of item.customFields) {
        let name = f.name.trim() || 'Field';
        if (STANDARD.has(name) || isTotpField(name)) name = `${name} (imported)`;
        let unique = name;
        for (let i = 2; names.has(unique); i++) unique = `${name} ${i}`;
        names.add(unique);
        fields.push({ name: unique, value: f.value, protected: f.protected });
      }
      let totp = item.totp;
      try {
        if (totp) normalizeTotpInput(totp, item.title);
      } catch {
        fields.push({ name: 'TOTP (unparsed)', value: totp, protected: true });
        totp = '';
      }
      this.saveEntry(null, {
        type: item.type,
        title: item.title || item.url || item.username || 'Untitled',
        username: item.username,
        password: item.password,
        url: item.url,
        notes: item.notes,
        tags: item.tags,
        favorite: item.favorite,
        folderId: group.uuid.id,
        expires: null,
        totp,
        customFields: fields,
      });
      count++;
    }
    return count;
  }

  /** Flattens active entries for CSV export (contains plaintext secrets!). */
  exportItems(): ImportedItem[] {
    const out: ImportedItem[] = [];
    for (const e of this.allEntries(false)) {
      const customFields: ImportedItem['customFields'] = [];
      for (const [k, v] of e.fields) {
        if (STANDARD.has(k) || isTotpField(k)) continue;
        customFields.push({ name: k, value: fieldText(v), protected: v instanceof ProtectedValue });
      }
      out.push({
        type: this.entryType(e),
        title: fieldText(e.fields.get(STD_FIELDS.title)),
        username: fieldText(e.fields.get(STD_FIELDS.username)),
        password: fieldText(e.fields.get(STD_FIELDS.password)),
        url: fieldText(e.fields.get(STD_FIELDS.url)),
        notes: fieldText(e.fields.get(STD_FIELDS.notes)),
        folder: this.folderPath(e.parentGroup).split(' / ').join('/'),
        tags: [...e.tags],
        favorite: this.isFavorite(e),
        totp: fieldText(e.fields.get(TOTP_FIELD)),
        customFields,
      });
    }
    return out;
  }
}
