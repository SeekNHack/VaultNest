import { describe, expect, it } from 'vitest';
import { validateRequest, ValidationError } from '../../src/host/views/rpcValidation';
import { DEFAULT_GENERATOR_OPTIONS } from '../../src/shared/model';
import { entryInput } from './helpers';

const req = (method: string, params: unknown) => ({ kind: 'request', id: 1, method, params });

describe('webview message validation', () => {
  it('accepts well-formed requests', () => {
    expect(() => validateRequest(req('ready', {}))).not.toThrow();
    expect(() => validateRequest(req('reveal', { vaultId: 'abc-123', entryId: 'AAAAAAAAAAAAAAAAAAAAAA==', field: 'Password' }))).not.toThrow();
    expect(() => validateRequest(req('saveEntry', { vaultId: 'v', entryId: null, input: entryInput({ password: { keep: true } }) }))).not.toThrow();
    expect(() => validateRequest(req('generate', { options: DEFAULT_GENERATOR_OPTIONS }))).not.toThrow();
  });

  it('rejects unknown methods, kinds and malformed envelopes', () => {
    expect(() => validateRequest(req('eval', {}))).toThrow(ValidationError);
    expect(() => validateRequest(req('__proto__', {}))).toThrow(ValidationError);
    expect(() => validateRequest({ kind: 'event', id: 1, method: 'ready', params: {} })).toThrow(ValidationError);
    expect(() => validateRequest({ kind: 'request', id: '1', method: 'ready', params: {} })).toThrow(ValidationError);
    expect(() => validateRequest(null)).toThrow(ValidationError);
  });


  it('rejects unknown or mistyped properties', () => {
    expect(() => validateRequest(req('ready', { extra: 1 }))).toThrow(/unknown property/);
    expect(() => validateRequest(req('reveal', { vaultId: 'v', entryId: 'e', field: 5 }))).toThrow(ValidationError);
    expect(() => validateRequest(req('reveal', { vaultId: '../../etc', entryId: 'e', field: 'x' }))).toThrow(ValidationError);
    expect(() => validateRequest(req('vaultCommand', { vaultId: 'v', command: 'rm -rf' }))).toThrow(ValidationError);
    expect(() => validateRequest(req('saveEntry', { vaultId: 'v', entryId: null, input: { ...entryInput(), type: 'virus' } }))).toThrow(ValidationError);
    expect(() => validateRequest(req('saveEntry', { vaultId: 'v', entryId: null, input: { ...entryInput(), password: { keep: true, x: 1 } } }))).toThrow(ValidationError);
    expect(() => validateRequest(req('copyText', { text: 'x'.repeat(2_000_000), sensitive: true }))).toThrow(ValidationError);
  });
});
