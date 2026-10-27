/** Minimal RFC 4180 CSV reader/writer (quoted fields, embedded newlines, CRLF/LF). */

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function escapeField(value: string): string {
  // Values are written verbatim (never prefixed to defuse spreadsheet formulas): altering a
  // password on export would silently corrupt it on re-import. The UI warns about opening
  // exports in spreadsheet software instead.
  const v = value;
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeField).join(',')).join('\r\n') + '\r\n';
}

/** Converts rows with a header line to objects keyed by lower-cased header names. */
export function csvObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, idx) => (o[h] = r[idx] ?? ''));
    return o;
  });
}
