import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../../src/core/io/csv';
import { exportBitwardenCsv, exportPasswdVaultCsv } from '../../src/core/io/exporters';
import { ImportError, parseImport } from '../../src/core/io/importers';
import type { ImportedItem } from '../../src/core/vault/VaultDocument';

describe('CSV', () => {
  it('round-trips quotes, commas, newlines and leading formula characters verbatim', () => {
    const rows = [['a', 'b,c', 'say "hi"'], ['multi\nline', '=SUM(A1)', ' padded ']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('handles BOM and CRLF', () => {
    expect(parseCsv('﻿x,y\r\n1,2\r\n')).toEqual([['x', 'y'], ['1', '2']]);
  });
  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('"abc')).toThrow();
  });
});

describe('importers', () => {
  it('parses Bitwarden JSON (logins, notes, cards, folders, hidden fields)', () => {
    const json = JSON.stringify({
      encrypted: false,
      folders: [{ id: 'f1', name: 'Work' }],
      items: [
        { type: 1, name: 'Site', folderId: 'f1', favorite: true, login: { username: 'u', password: 'p', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://a' }, { uri: 'https://b' }] }, fields: [{ name: 'pin', value: '1', type: 1 }] },
        { type: 2, name: 'Note', notes: 'text' },
        { type: 3, name: 'Visa', card: { cardholderName: 'Me', number: '4111', expMonth: '3', expYear: '2030', code: '123' } },
      ],
    });
    const [login, note, card] = parseImport('bitwardenJson', json);
    expect(login).toMatchObject({ type: 'login', title: 'Site', folder: 'Work', favorite: true, username: 'u', password: 'p', url: 'https://a' });
    expect(login.customFields).toContainEqual({ name: 'pin', value: '1', protected: true });
    expect(login.customFields).toContainEqual({ name: 'URL', value: 'https://b', protected: false });
    expect(note).toMatchObject({ type: 'note', notes: 'text' });
    expect(card.type).toBe('card');
    expect(card.customFields).toContainEqual({ name: 'Expiration (MM/YY)', value: '03/30', protected: false });
    expect(() => parseImport('bitwardenJson', '{"encrypted":true}')).toThrow(ImportError);
  });

  it('parses Bitwarden CSV', () => {
    const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nSocial,1,login,X,n,"a: 1\nb: 2",0,https://x.com,me,pw,\n';
    const [it] = parseImport('bitwardenCsv', csv);
    expect(it).toMatchObject({ folder: 'Social', favorite: true, title: 'X', username: 'me', password: 'pw', url: 'https://x.com' });
    expect(it.customFields).toHaveLength(2);
  });

  it('parses KeePassXC CSV', () => {
    const csv = '"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root/Email","Mail","me","pw","https://m","","","0","",""\n';
    const [it] = parseImport('keepassxcCsv', csv);
    expect(it).toMatchObject({ folder: 'Email', title: 'Mail', username: 'me', password: 'pw' });
  });

  it('parses browser CSV and validates headers', () => {
    const [it] = parseImport('browserCsv', 'name,url,username,password\n,https://ex.com/login,a,b\n');
    expect(it.title).toBe('ex.com');
    expect(() => parseImport('browserCsv', 'foo,bar\n1,2')).toThrow(ImportError);
  });

  it('round-trips the PasswdVault CSV format', () => {
    const items: ImportedItem[] = [{ type: 'apiKey', title: 'AWS', username: 'AKIA', password: '-secret', url: '', notes: 'n', folder: 'Cloud/Prod', tags: ['aws', 'prod'], favorite: true, totp: '', customFields: [{ name: 'Region', value: 'eu', protected: false }] }];
    expect(parseImport('passwdvaultCsv', exportPasswdVaultCsv(items))).toEqual(items);
    expect(parseImport('bitwardenCsv', exportBitwardenCsv(items))[0]).toMatchObject({ title: 'AWS', password: '-secret', folder: 'Cloud/Prod' });
  });
});
