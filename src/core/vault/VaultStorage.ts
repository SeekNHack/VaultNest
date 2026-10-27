import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

/** KDBX files start with these two little-endian signatures. */
const KDBX_MAGIC = [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5];

export interface FileSnapshot {
  bytes: Uint8Array;
  /** SHA-256 of the file content, used to detect external modifications. */
  fingerprint: string;
}

export interface BackupOptions {
  enabled: boolean;
  directory: string;
  keep: number;
}

export function fingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function looksLikeKdbx(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && KDBX_MAGIC.every((b, i) => bytes[i] === b);
}

export async function readVaultFile(file: string): Promise<FileSnapshot> {
  const bytes = new Uint8Array(await fs.readFile(file));
  if (!looksLikeKdbx(bytes)) throw new Error('This file is not a KeePass (KDBX) database.');
  return { bytes, fingerprint: fingerprint(bytes) };
}

/** Returns the fingerprint of the file on disk, or null if it does not exist. */
export async function currentFingerprint(file: string): Promise<string | null> {
  try {
    return fingerprint(new Uint8Array(await fs.readFile(file)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Crash-safe write: data is written to a temporary file in the same directory,
 * flushed to disk, verified, and atomically renamed over the destination.
 * A crash at any point leaves either the old or the new complete file.
 */
export async function writeFileAtomic(file: string, bytes: Uint8Array, verify?: (written: Uint8Array) => Promise<void>): Promise<string> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
  } catch {
    mode = 0o600; // new vaults are private to the user
  }
  const handle = await fs.open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const written = new Uint8Array(await fs.readFile(tmp));
    if (fingerprint(written) !== fingerprint(bytes)) throw new Error('Verification of the written vault failed.');
    if (verify) await verify(written);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await syncDirectory(dir);
  return fingerprint(bytes);
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be fsync'ed on Windows
  try {
    const h = await fs.open(dir, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // best effort
  }
}

function backupStem(file: string): string {
  return path.basename(file).replace(/\.kdbx$/i, '');
}

/** Copies the current vault file into the backup directory and prunes old backups. Returns the backup path. */
export async function backupVaultFile(file: string, opts: BackupOptions, now = new Date()): Promise<string | null> {
  if (!opts.enabled) return null;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  await fs.mkdir(opts.directory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(opts.directory, `${backupStem(file)}.${stamp}.kdbx`);
  await writeFileAtomic(target, new Uint8Array(bytes));
  await pruneBackups(file, opts);
  return target;
}

export async function listBackups(file: string, directory: string): Promise<string[]> {
  const stem = backupStem(file);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.kdbx$`);
  return names.filter((n) => re.test(n)).sort().map((n) => path.join(directory, n));
}

async function pruneBackups(file: string, opts: BackupOptions): Promise<void> {
  const all = await listBackups(file, opts.directory);
  const excess = all.length - Math.max(1, opts.keep);
  for (const old of all.slice(0, Math.max(0, excess))) await fs.rm(old, { force: true });
}
