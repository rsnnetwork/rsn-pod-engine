// ─── Reading an allowed-email list (Part 2, Task 4, 10 Nov 2026) ────────────────────────────────────────────
//
// An organiser pastes addresses or uploads a CSV (a Luma or Eventbrite export, a spreadsheet saved as CSV). This reads
// it with string operations only, one character at a time: never a regex over upload-sized text (Global Constraints;
// a regex over a large payload overflowed Node 20's stack in CI once). A regex is never used here at all.
//
// The column: a header cell named `email`, `e-mail` or `email address` (any case, surrounding spaces ignored) picks
// it. Without one, each row's first cell that contains '@' is its address, and a first row with no '@' anywhere is
// taken as a header and skipped. Quoted cells ("a, b"), doubled quotes inside them, a byte-order mark, CRLF, LF or
// CR line ends, and comma, semicolon or tab separators (whichever the first line uses most) are all read.

import { AppError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

/** The largest CSV text read in one import. */
export const ADMISSION_CSV_MAX_BYTES = 256 * 1024;

const HEADER_NAMES = new Set(['email', 'e-mail', 'email address', 'e-mail address']);

/**
 * An address as stored (trimmed, lower-cased), or null when it cannot be one: one '@' with something before it, a
 * domain with a dot that neither starts nor ends it, no spaces, quotes, commas or angle brackets, 255 characters at
 * most. Deliberately plain: the list is matched against the address a person signs in with, which RSN has checked.
 */
export function normaliseAdmissionEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 255) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot === domain.length - 1 || domain.startsWith('.') || domain.includes('..')) return null;
  for (const ch of email) {
    if (ch <= ' ' || ch === '"' || ch === ',' || ch === ';' || ch === '<' || ch === '>' || ch === '(' || ch === ')'
      || ch === '[' || ch === ']' || ch === '\\' || ch === '\u007f') return null;
  }
  return email;
}

/** The separator the first line uses most, outside quotes: a comma unless semicolons or tabs outnumber it. */
function separatorOf(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

/** The rows of the text, each a list of cells, quotes undone. A blank line is no row. */
export function csvRows(text: string): string[][] {
  const sep = separatorOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cellWasQuoted = false;
  const endCell = () => { row.push(cellWasQuoted ? cell : cell.trim()); cell = ''; cellWasQuoted = false; };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true; cellWasQuoted = true; continue; }
    if (ch === sep) { endCell(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    cell += ch;
  }
  endRow();
  return rows;
}

/**
 * The addresses in a CSV, in file order and each once, and the rows (1-based, the header being row 1) that hold none
 * that could be one. Over ADMISSION_CSV_MAX_BYTES it is refused with 413 before anything is read.
 */
export function parseAdmissionCsv(text: string): { emails: string[]; invalidRows: number[] } {
  if (Buffer.byteLength(text, 'utf8') > ADMISSION_CSV_MAX_BYTES) {
    throw new AppError(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'That file is too big. Import at most 256 KB at a time.');
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = csvRows(body);
  const emails: string[] = [];
  const seen = new Set<string>();
  const invalidRows: number[] = [];
  if (rows.length === 0) return { emails, invalidRows };

  const headerColumn = rows[0].findIndex((c) => HEADER_NAMES.has(c.trim().toLowerCase()));
  const firstRowIsHeader = headerColumn >= 0 || !rows[0].some((c) => c.includes('@'));
  rows.forEach((cells, index) => {
    if (index === 0 && firstRowIsHeader) return;
    const raw = headerColumn >= 0 ? (cells[headerColumn] ?? '') : (cells.find((c) => c.includes('@')) ?? '');
    const email = normaliseAdmissionEmail(raw);
    if (!email) { invalidRows.push(index + 1); return; }
    if (seen.has(email)) return;
    seen.add(email);
    emails.push(email);
  });
  return { emails, invalidRows };
}
