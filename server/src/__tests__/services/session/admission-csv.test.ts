// ─── Reading an allowed-email list from a CSV (Part 2, Task 4, 10 Nov 2026) ─────────────────────────────────
// Spec 04 ("allowed email list"), 11 ("imported approval lists ... handled securely"), edge case "duplicate email".
// The parser reads with string operations only (Global Constraints: never a regex over upload-sized text); its source
// is checked for that too.

import * as fs from 'fs';
import * as path from 'path';
import {
  ADMISSION_CSV_MAX_BYTES, csvRows, normaliseAdmissionEmail, parseAdmissionCsv,
} from '../../../services/session/admission-csv';

describe('parseAdmissionCsv', () => {
  it('reads a Luma-style export by its email column, and skips the header', () => {
    const csv = 'name,email,ticket\nAna Diaz,ana@example.com,VIP\nBo Lee,Bo.Lee@Example.COM ,General\n';
    expect(parseAdmissionCsv(csv)).toEqual({ emails: ['ana@example.com', 'bo.lee@example.com'], invalidRows: [] });
  });

  it.each(['Email', 'E-mail', 'EMAIL ADDRESS', ' email '])('finds the column by the header %p, in any case', (header) => {
    const csv = `first,${header},last\nA,a@x.io,Z\n`;
    expect(parseAdmissionCsv(csv).emails).toEqual(['a@x.io']);
  });

  it('reads a file that starts with a byte-order mark', () => {
    const csv = '﻿email,name\r\nz@x.io,Zed\r\n';
    expect(parseAdmissionCsv(csv)).toEqual({ emails: ['z@x.io'], invalidRows: [] });
  });

  it('keeps commas inside quoted cells, and doubled quotes inside them', () => {
    const csv = 'name,email,note\n"Diaz, Ana",ana@x.io,"she said ""hi"", twice"\n"Lee, Bo","bo@x.io",x\n';
    expect(parseAdmissionCsv(csv).emails).toEqual(['ana@x.io', 'bo@x.io']);
    expect(csvRows(csv)[1]).toEqual(['Diaz, Ana', 'ana@x.io', 'she said "hi", twice']);
  });

  it('reads CRLF, LF and lone CR line ends, and a quoted cell that spans lines', () => {
    expect(parseAdmissionCsv('email\r\na@x.io\r\nb@x.io').emails).toEqual(['a@x.io', 'b@x.io']);
    expect(parseAdmissionCsv('email\ra@x.io\rb@x.io\r').emails).toEqual(['a@x.io', 'b@x.io']);
    expect(parseAdmissionCsv('note,email\n"two\nlines",a@x.io\n').emails).toEqual(['a@x.io']);
  });

  it('counts an address that appears more than once in the file once (edge case: duplicate email)', () => {
    const csv = 'email\na@x.io\nA@X.IO\n b@x.io \na@x.io\n';
    expect(parseAdmissionCsv(csv).emails).toEqual(['a@x.io', 'b@x.io']);
  });

  it('without an email header, takes each row\'s first cell holding an @, and a first row without one as a header', () => {
    expect(parseAdmissionCsv('Name,Contact\nAna,ana@x.io\nBo,bo@x.io\n').emails).toEqual(['ana@x.io', 'bo@x.io']);
    expect(parseAdmissionCsv('ana@x.io\nbo@x.io\n').emails).toEqual(['ana@x.io', 'bo@x.io']);
  });

  it('names the rows (header = row 1) that hold no address that could be one, and blank lines are no rows', () => {
    const csv = 'name,email\nAna,ana@x.io\n\nBo,not-an-address\nCy,\nDi,di@x\n';
    expect(parseAdmissionCsv(csv)).toEqual({ emails: ['ana@x.io'], invalidRows: [3, 4, 5] });
  });

  it('reads semicolon- and tab-separated exports', () => {
    expect(parseAdmissionCsv('name;email\n"Diaz; Ana";ana@x.io\n').emails).toEqual(['ana@x.io']);
    expect(parseAdmissionCsv('name\temail\nAna\tana@x.io\n').emails).toEqual(['ana@x.io']);
  });

  it('refuses more than 256 KB with 413 before reading it', () => {
    const big = 'email\n' + 'a'.repeat(ADMISSION_CSV_MAX_BYTES);
    expect(() => parseAdmissionCsv(big)).toThrow(expect.objectContaining({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
  });

  it('reads 2,500 rows quickly, with no regex anywhere in the module', () => {
    const lines = ['name,email'];
    for (let i = 0; i < 2500; i++) lines.push(`"Person, ${i}",p${i}@example.com`);
    const started = Date.now();
    expect(parseAdmissionCsv(lines.join('\r\n')).emails).toHaveLength(2500);
    expect(Date.now() - started).toBeLessThan(1000);
    const source = fs.readFileSync(path.join(__dirname, '../../../services/session/admission-csv.ts'), 'utf8');
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/new RegExp|\.match\(|\.replace\(|\.test\(|\.split\(\//);
  });
});

describe('normaliseAdmissionEmail', () => {
  it('trims and lower-cases a plain address', () => {
    expect(normaliseAdmissionEmail('  Ana.Diaz+rsn@Example.CO.UK ')).toBe('ana.diaz+rsn@example.co.uk');
  });
  it.each(['', 'ana', 'ana@', '@x.io', 'a@b@x.io', 'a@x', 'a@.x.io', 'a@x.', 'a b@x.io', '"a"@x.io', 'Ana <a@x.io>', 'a@x..io',
    `${'a'.repeat(251)}@x.io`])('refuses %p', (raw) => {
    expect(normaliseAdmissionEmail(raw)).toBeNull();
  });
});
