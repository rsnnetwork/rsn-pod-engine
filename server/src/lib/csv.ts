// ─── CSV for a spreadsheet (one writer for every server export) ──────────────────────────────────────────────────
//
// RFC 4180 cells, and a guard against a cell a spreadsheet would run as a formula: member-written text (a name, an
// answer) can start with =, +, -, @, a tab or a carriage return, and such a cell is written with a ' in front.
//
// The regexes here only ever see ONE cell (a name, a time, a short answer). A file is assembled by joining strings,
// never searched with a regex: a regex over upload-sized text overflows Node 20's stack (admission-csv.ts).

/** The UTF-8 byte-order mark, so Excel reads a non-ASCII name (Søren, Zoë) as it was written. */
export const CSV_BOM = '﻿';

export type CsvValue = string | number | null | undefined;

/**
 * One cell: quoted when it holds a comma, a quote or a line break; text a spreadsheet would run as a formula is
 * written with a ' in front. A number is written as it is (-3 is a number to a spreadsheet, never a formula).
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One line of cells, without its line break. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(',');
}

/** A whole file for a spreadsheet: the BOM, then each row ending CRLF. */
export function csvDocumentWithBom(rows: readonly (readonly CsvValue[])[]): string {
  const lines: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) lines[i] = csvRow(rows[i]);
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
