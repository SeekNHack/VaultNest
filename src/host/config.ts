import * as vscode from 'vscode';
import type { KdfSettings } from '../core/vault/VaultDocument';

const SECTION = 'vaultnest';

function get<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

function num(key: string, fallback: number, min: number, max: number): number {
  const v = Number(get<number>(key, fallback));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Typed, clamped accessors for the extension settings (see package.json). */
export const config = {
  autoLockMinutes: () => num('autoLock.minutes', 15, 0, 1440),
  lockOnWindowBlur: () => get('autoLock.onWindowBlur', false),
  blurGraceSeconds: () => num('autoLock.blurGraceSeconds', 0, 0, 3600),
  clipboardClearSeconds: () => num('clipboard.clearAfterSeconds', 30, 0, 600),
  backupEnabled: () => get('backup.enabled', true),
  backupCount: () => num('backup.count', 10, 1, 100),
  backupIntervalMinutes: () => num('backup.intervalMinutes', 60, 0, 10080),
  backupLocation: () => get<'extensionStorage' | 'besideVault'>('backup.location', 'extensionStorage'),
  kdf: (): KdfSettings => ({
    memoryMiB: num('security.kdfMemoryMiB', 64, 8, 1024),
    iterations: num('security.kdfIterations', 3, 1, 100),
    parallelism: 2,
  }),
  minMasterPasswordScore: () => num('security.minMasterPasswordScore', 2, 0, 4),
  showPasswordStrength: () => get('ui.showPasswordStrength', true),
  openDashboardOnUnlock: () => get('ui.openDashboardOnUnlock', false),
  showStatusBar: () => get('ui.showStatusBar', true),
  maxPasswordAgeDays: () => num('health.maxPasswordAgeDays', 365, 0, 3650),
  affects: (e: vscode.ConfigurationChangeEvent, key?: string) => e.affectsConfiguration(key ? `${SECTION}.${key}` : SECTION),
};
