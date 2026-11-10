// ─── Admission on the event page: the words and the small pure steps (Part 2 Task 11; spec 04, 11) ──────────────────
// Pure (types from shared only), so the client test runs it. Pasted text and imported files are read with string
// steps, never a regular expression over the whole text (a 256 KB paste must not stall or overflow the page).
import type { AddAdmissionEmailsResult, AdmissionCodeRow, AdmissionMode, GeneratedAdmissionCode } from '@rsn/shared';

export const ADMISSION_COPY = {
  title: 'Admission',
  hint: 'Who gets a place. Who can see the event is still its "Who can join" setting.',
  modeLegend: 'Who gets a place',
  noMode: 'No admission mode yet: places follow the event\'s "Who can join" setting.',
  save: 'Save',
  saved: 'Admission saved.',
  clear: 'Use the usual rules again',
  clearTitle: 'Use the usual rules again?',
  clearBody: 'This turns the admission mode off. Who gets a place then follows only the event\'s "Who can join" setting, as it stands now. The allowed emails and codes stay on the list but no longer give anyone a place. Everyone who already has a place keeps it.',
  clearConfirm: 'Turn admission off',
  cleared: 'Admission now follows the usual rules.',
  chooseMode: 'Choose who gets a place.',
  error: 'Admission could not be read just now.',
  fallback: 'That did not go through. Please try again.',
  // Allowed emails
  emailsTitle: 'Allowed emails',
  pasteLabel: 'Paste email addresses',
  pastePlaceholder: 'ana@example.com, ben@example.com',
  pasteHint: 'Separate them with commas or new lines.',
  add: 'Add',
  importCsv: 'Import a CSV',
  noAddresses: 'No email addresses found. Paste addresses separated by commas or new lines.',
  csvTooBig: 'That file is too big. Split it into files under 256 KB.',
  csvUnreadable: 'That file could not be read. Save it as a CSV and try again.',
  tooManyPasted: (n: number) => `That is ${n.toLocaleString('en-GB')} addresses. Add at most 2,000 at a time: split the list and add the rest next.`,
  tooManyRows: 'That file has more than 2,000 rows. Split it into files of at most 2,000 addresses and import each.',
  emailsEmpty: 'No allowed emails yet. Paste addresses or import a CSV.',
  emailsNoMatch: 'No allowed email matches that search.',
  emailsError: 'The allowed emails could not be read just now.',
  search: 'Search the list',
  showMore: 'Show more',
  remove: 'Remove',
  removeTitle: (email: string) => `Remove ${email}?`,
  removeBody: 'They can no longer take a place with this address. A place they already hold stays, but the live event will not let them in.',
  removed: 'Address removed.',
  // Admission codes
  codesTitle: 'Admission codes',
  codesHint: 'One code lets one person take a place. Give each person their own.',
  howMany: 'How many codes',
  label: 'Label (optional)',
  labelPlaceholder: 'For the speakers',
  generate: 'Make codes',
  countRange: 'Make between 1 and 500 codes at a time.',
  onceOnly: 'These codes are shown only now. Download or copy them before you leave.',
  downloadCsv: 'Download CSV',
  copyAll: 'Copy all',
  copied: 'Copied',
  copyFailed: 'The codes could not be copied. Download them instead.',
  done: 'I have saved them',
  closeTitle: 'Put these codes away?',
  replaceTitle: 'Make new codes?',
  unsavedBody: 'The codes on screen have not been downloaded or copied, and they can never be shown again. Codes nobody saved can only be revoked.',
  closeConfirm: 'Put them away',
  replaceConfirm: 'Make new codes',
  codesEmpty: 'No admission codes yet.',
  codesError: 'The admission codes could not be read just now.',
  revoke: 'Revoke',
  revokeTitle: 'Revoke this code?',
  revokeBody: 'It stops working. If someone already used it, they lose the place it gave them.',
  revoked: 'Code revoked.',
} as const;

/** The three modes, in the order the form offers them, in the organiser's words. */
export const ADMISSION_MODE_LABELS: Record<AdmissionMode, string> = {
  open: 'Open: anyone with the link',
  approval: 'Approval: you approve each person',
  restricted: 'Invitation only: allowed emails or admission codes',
};

/** The most addresses the server adds in one call (ADMISSION_EMAILS_MAX): more is refused as a whole, so the page says so first. */
export const ADMISSION_EMAILS_PER_CALL = 2000;

/**
 * Whether a CSV has more address rows than one call takes: its non-empty lines, one of them allowed as a header (the
 * server reads one address per row). Counted with a string scan, never a regular expression over the file.
 */
export function csvHasTooManyRows(text: string): boolean {
  let rows = 0;
  let filled = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      if (filled) rows++;
      filled = false;
    } else if (ch !== '\r' && ch !== ' ' && ch !== '\t' && ch !== ',' && ch !== ';') {
      filled = true;
    }
  }
  if (filled) rows++;
  return rows > ADMISSION_EMAILS_PER_CALL + 1;
}

/** The largest CSV the page reads (the server takes 300 KB at most, with room for the request around it). */
export const CSV_MAX_BYTES = 256 * 1024;

/** Whether the lists (allowed emails, codes) decide anything in this mode: approval admits them directly, invitation only admits only them. */
export const modeUsesLists = (mode: AdmissionMode | null | undefined): boolean => mode === 'approval' || mode === 'restricted';

const SEPARATORS = new Set([',', ';', '\n', '\r', '\t', ' ']);

/**
 * The addresses in pasted text: split on commas, semicolons, spaces and new lines, a surrounding <…> or quotes taken
 * off ("Ana Lee <ana@example.com>" gives ana@example.com), words without an @ left out (the names around them). Each
 * address once (lower-cased, as the server stores it); `repeats` counts the ones given more than once.
 */
export function splitPastedEmails(text: string): { emails: string[]; repeats: number } {
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SEPARATORS.has(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  const seen = new Set<string>();
  const emails: string[] = [];
  let repeats = 0;
  for (const token of tokens) {
    const email = stripWrapping(token).toLowerCase();
    if (!email.includes('@')) continue;
    if (seen.has(email)) { repeats++; continue; }
    seen.add(email);
    emails.push(email);
  }
  return { emails, repeats };
}

const WRAPPERS = new Set(['<', '>', '"', "'", '(', ')', '[', ']']);
function stripWrapping(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && WRAPPERS.has(token[start])) start++;
  while (end > start && WRAPPERS.has(token[end - 1])) end--;
  const inner = token.slice(start, end);
  // "Ana<ana@example.com>" written without a space: the part inside the brackets.
  const open = inner.lastIndexOf('<');
  return open >= 0 ? inner.slice(open + 1) : inner;
}

/** "2 added, 1 already listed", with what came back on the list and what could not be read. */
export function addedSentence(result: AddAdmissionEmailsResult, repeats = 0): string {
  const parts = [`${result.added} added`];
  const already = result.alreadyListed + repeats;
  if (already > 0) parts.push(`${already} already listed`);
  if (result.restored > 0) parts.push(`${result.restored} back on the list`);
  let sentence = parts.join(', ');
  if (result.invalid.length > 0) {
    const shown = result.invalid.slice(0, 3).join(', ');
    const more = result.invalid.length > 3 ? ` and ${result.invalid.length - 3} more` : '';
    sentence += `. Not an email address: ${shown}${more}`;
  }
  return `${sentence}.`;
}

/** The generated codes as a CSV file's text: a header, then one code (and its label) per line. */
export function codesCsv(codes: readonly GeneratedAdmissionCode[], label: string | null): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.split('"').join('""')}"` : value);
  const lines = ['code,label', ...codes.map((c) => `${c.code},${cell(label ?? '')}`)];
  return `${lines.join('\n')}\n`;
}

/** The codes for the clipboard: one per line. */
export const codesText = (codes: readonly GeneratedAdmissionCode[]): string => codes.map((c) => c.code).join('\n');

/** A file name for the download, from the event's title: letters, digits and dashes. */
export function codesFileName(title: string): string {
  let slug = '';
  for (const ch of title.toLowerCase()) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (ok) slug += ch;
    else if (!slug.endsWith('-')) slug += '-';
    if (slug.length >= 40) break;
  }
  const trimmed = slug.replace(/^-+|-+$/g, '');
  return `${trimmed || 'event'}-admission-codes.csv`;
}

export const CODE_STATUS_LABELS: Record<AdmissionCodeRow['status'], string> = {
  unused: 'Not used yet',
  used: 'Used',
  revoked: 'Revoked',
  expired: 'Expired',
};

export const EMAIL_STATUS_LABELS = {
  listed: 'Listed',
  registered: 'Has a place',
  revoked: 'Removed',
} as const;
