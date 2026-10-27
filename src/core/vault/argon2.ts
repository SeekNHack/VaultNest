import * as kdbxweb from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

let installed = false;

/**
 * kdbxweb does not ship an Argon2 implementation. We plug in hash-wasm, an
 * audited-by-usage WebAssembly port of the reference Argon2 implementation
 * (RFC 9106), which runs in Node without native modules.
 */
export function installArgon2(): void {
  if (installed) return;
  kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
    if (version !== 0x13) {
      throw new kdbxweb.KdbxError(kdbxweb.Consts.ErrorCodes.Unsupported, 'Argon2 v1.0 (0x10) is not supported; re-save the database with a recent KeePass client');
    }
    const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
    const result = await fn({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory, // KiB (kdbxweb already converts from bytes)
      iterations,
      parallelism,
      hashLength: length,
      outputType: 'binary',
    });
    const out = result.slice().buffer;
    result.fill(0);
    return out;
  });
  installed = true;
}
