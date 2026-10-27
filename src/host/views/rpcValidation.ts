import { isItemType, type EntryInput, type GeneratorOptions } from '../../shared/model';
import { VAULT_COMMANDS, type RpcMethod, type RpcRequest } from '../../shared/protocol';

/**
 * Strict validation of messages received from the webview. Even though the
 * webview runs our own code under a strict CSP, it renders data coming from
 * vault files, so it is treated as an untrusted boundary.
 */
export class ValidationError extends Error {}

type Check = (v: unknown, path: string) => void;

const fail = (path: string, what: string): never => {
  throw new ValidationError(`Invalid message: ${path} must be ${what}`);
};

const str = (max = 1_048_576): Check => (v, p) => {
  if (typeof v !== 'string') fail(p, 'a string');
  if ((v as string).length > max) fail(p, `at most ${max} chars`);
};
const id: Check = (v, p) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/=_-]{1,64}$/.test(v)) fail(p, 'an id');
};
const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'a boolean');
};
const num = (min: number, max: number): Check => (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(p, `a number in [${min}, ${max}]`);
};
const nullable = (c: Check): Check => (v, p) => {
  if (v !== null) c(v, p);
};
const optional = (c: Check): Check => (v, p) => {
  if (v !== undefined) c(v, p);
};
const oneOf = (values: readonly string[]): Check => (v, p) => {
  if (typeof v !== 'string' || !values.includes(v)) fail(p, `one of ${values.join(', ')}`);
};
const arr = (c: Check, max: number): Check => (v, p) => {
  if (!Array.isArray(v)) fail(p, 'an array');
  if ((v as unknown[]).length > max) fail(p, `at most ${max} items`);
  (v as unknown[]).forEach((x, i) => c(x, `${p}[${i}]`));
};
const fieldValue = (max: number): Check => (v, p) => {
  if (typeof v === 'object' && v !== null && (v as { keep?: unknown }).keep === true && Object.keys(v).length === 1) return;
  str(max)(v, p);
};
const obj = (shape: Record<string, Check>): Check => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'an object');
  for (const key of Object.keys(v as object)) if (!(key in shape)) fail(`${p}.${key}`, 'absent (unknown property)');
  for (const [key, check] of Object.entries(shape)) check((v as Record<string, unknown>)[key], `${p}.${key}`);
};

const empty = obj({});
const vaultRef = { vaultId: id };
const entryRef = { vaultId: id, entryId: id };

const generatorOptions: Check = obj({
  mode: oneOf(['password', 'passphrase']),
  length: num(0, 1000), uppercase: bool, lowercase: bool, digits: bool, symbols: bool,
  minDigits: num(0, 1000), minSymbols: num(0, 1000), avoidAmbiguous: bool,
  words: num(0, 1000), separator: str(10), capitalize: bool, includeNumber: bool,
});

const entryInput: Check = (v, p) => {
  obj({
    type: (t, tp) => { if (!isItemType(t)) fail(tp, 'an item type'); },
    title: str(4096), username: str(4096), password: fieldValue(1_048_576), url: str(8192), notes: str(1_048_576),
    tags: arr(str(200), 64), favorite: bool, folderId: nullable(id), expires: nullable(num(0, 8.64e15)),
    totp: fieldValue(4096),
    customFields: arr(obj({ name: str(256), originalName: optional(str(256)), value: fieldValue(1_048_576), protected: bool }), 200),
  })(v, p);
};

const schemas: { [M in RpcMethod]: Check } = {
  ready: empty,
  setActiveVault: obj(vaultRef),
  unlock: obj(vaultRef),
  lock: obj(vaultRef),
  createVault: empty,
  openVault: empty,
  getEntry: obj(entryRef),
  reveal: obj({ ...entryRef, field: str(256) }),
  copyField: obj({ ...entryRef, field: str(256) }),
  copyText: obj({ text: str(1_048_576), sensitive: bool }),
  getTotp: obj(entryRef),
  openUrl: obj({ url: str(8192) }),
  saveEntry: obj({ vaultId: id, entryId: nullable(id), input: entryInput }),
  deleteEntry: obj(entryRef),
  restoreEntry: obj(entryRef),
  toggleFavorite: obj(entryRef),
  moveEntry: obj({ ...entryRef, folderId: id }),
  emptyTrash: obj(vaultRef),
  createFolder: obj({ vaultId: id, parentId: nullable(id) }),
  renameFolder: obj({ vaultId: id, folderId: id }),
  deleteFolder: obj({ vaultId: id, folderId: id }),
  generate: obj({ options: generatorOptions }),
  getGeneratorOptions: empty,
  saveGeneratorOptions: obj({ options: generatorOptions }),
  strength: obj({ value: str(4096) }),
  health: obj(vaultRef),
  vaultCommand: obj({ vaultId: id, command: oneOf(VAULT_COMMANDS) }),
  openSettings: empty,
};

export function validateRequest(msg: unknown): RpcRequest {
  if (typeof msg !== 'object' || msg === null) throw new ValidationError('Invalid message');
  const m = msg as Record<string, unknown>;
  if (m.kind !== 'request') throw new ValidationError('Invalid message kind');
  if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id)) throw new ValidationError('Invalid message id');
  if (typeof m.method !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, m.method)) throw new ValidationError('Unknown method');
  schemas[m.method as RpcMethod](m.params, 'params');
  return m as unknown as RpcRequest;
}

export type { EntryInput, GeneratorOptions };
