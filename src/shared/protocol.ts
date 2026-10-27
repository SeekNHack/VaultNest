/**
 * Message protocol between the dashboard webview and the extension host.
 *
 * The webview issues RPC requests ({@link RpcRequest}); the host answers with
 * {@link RpcResponse}. The host also pushes events ({@link HostEvent}).
 * Every inbound message is validated by the host before use (see
 * `src/host/views/rpcValidation.ts`), the webview is never trusted.
 */
import type {
  EntryDetail, EntryInput, EntrySummary, FolderNode, GeneratorOptions, HealthReport,
  StrengthResult, VaultInfo,
} from './model';

export type View = 'items' | 'generator' | 'health' | 'settings';

export interface DashboardState {
  vaults: VaultInfo[];
  activeVaultId: string | null;
  folders: FolderNode[];
  entries: EntrySummary[];
  tags: string[];
  prefs: { showPasswordStrength: boolean; clipboardClearSeconds: number };
}

/** RPC method signatures: [params, result]. */
export interface RpcMethods {
  ready: [Record<string, never>, DashboardState];
  setActiveVault: [{ vaultId: string }, void];
  unlock: [{ vaultId: string }, boolean];
  lock: [{ vaultId: string }, void];
  createVault: [Record<string, never>, void];
  openVault: [Record<string, never>, void];
  getEntry: [{ vaultId: string; entryId: string }, EntryDetail];
  reveal: [{ vaultId: string; entryId: string; field: string }, string];
  copyField: [{ vaultId: string; entryId: string; field: string }, void];
  copyText: [{ text: string; sensitive: boolean }, void];
  getTotp: [{ vaultId: string; entryId: string }, { code: string; period: number; remaining: number } | null];
  openUrl: [{ url: string }, void];
  saveEntry: [{ vaultId: string; entryId: string | null; input: EntryInput }, string];
  deleteEntry: [{ vaultId: string; entryId: string }, boolean];
  restoreEntry: [{ vaultId: string; entryId: string }, void];
  toggleFavorite: [{ vaultId: string; entryId: string }, void];
  moveEntry: [{ vaultId: string; entryId: string; folderId: string }, void];
  emptyTrash: [{ vaultId: string }, void];
  createFolder: [{ vaultId: string; parentId: string | null }, void];
  renameFolder: [{ vaultId: string; folderId: string }, void];
  deleteFolder: [{ vaultId: string; folderId: string }, void];
  generate: [{ options: GeneratorOptions }, { value: string; strength: StrengthResult }];
  getGeneratorOptions: [Record<string, never>, GeneratorOptions];
  saveGeneratorOptions: [{ options: GeneratorOptions }, void];
  strength: [{ value: string }, StrengthResult];
  health: [{ vaultId: string }, HealthReport];
  vaultCommand: [{ vaultId: string; command: VaultCommand }, void];
  openSettings: [Record<string, never>, void];
  /** Reads a 2FA QR code from the screen or an image file (chosen by the user in a host dialog). */
  scanQr: [{ source: 'screen' | 'file' }, ScannedOtp | null];
  /** Reads a 2FA QR code from an image pasted or dropped into the webview (base64 PNG/JPEG). */
  decodeQrImage: [{ image: string }, ScannedOtp | null];
}

/** A scanned 2FA account. `uri` is the secret otpauth:// URI, sent only in reply to an explicit user action. */
export interface ScannedOtp { uri: string; issuer: string; account: string }

/** Largest pasted/dropped image accepted, as base64 characters (≈ 15 MB of image data). */
export const MAX_QR_IMAGE_BASE64 = 20_000_000;

export type VaultCommand =
  | 'changeMasterPassword' | 'backupNow' | 'openBackupFolder' | 'sync' | 'import' | 'export'
  | 'remove' | 'reveal' | 'rename' | 'upgradeFormat' | 'editDescription';

export const VAULT_COMMANDS: readonly VaultCommand[] = [
  'changeMasterPassword', 'backupNow', 'openBackupFolder', 'sync', 'import', 'export',
  'remove', 'reveal', 'rename', 'upgradeFormat', 'editDescription',
];

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  kind: 'request';
  id: number;
  method: M;
  params: RpcParams<M>;
}

export interface RpcResponse {
  kind: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type HostEvent =
  | { kind: 'event'; type: 'state'; state: DashboardState }
  | { kind: 'event'; type: 'navigate'; view: View; vaultId?: string; entryId?: string; edit?: boolean; newItem?: { type?: string; password?: string; folderId?: string } }
  | { kind: 'event'; type: 'locked'; vaultId: string }
  | { kind: 'event'; type: 'toast'; message: string; level: 'info' | 'error' };

export type HostMessage = RpcResponse | HostEvent;
