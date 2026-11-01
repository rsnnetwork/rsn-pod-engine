// ─── Every notification type the code inserts is one the database allows (1 Nov 2026) ───────────────────────────
//
// notifications_type_check is an allowlist. A type the code inserts that is missing from it makes every insert of
// that type fail; the insert sits in a best-effort catch, so nothing shows except a warning in the log. That is how
// circle invites went without a bell from migration 090 on, until 118 added the type. This test reads every
// notification insert in server/src and fails when a type it writes is not in the latest definition of the list
// (118's), so the next type to be added without a migration fails here, before it ships.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../..');
const MIGRATION_118 = path.join(SRC, 'db/migrations/118_notification_types_circles.sql');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** The text up to the bracket or paren that closes the one opened just before `from`, quotes and nesting respected. */
function balanced(text: string, from: number, open: string, close: string): string {
  let depth = 1;
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Splits at the commas that are not inside a quote, a bracket or a paren. */
function topLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** The bodies of the top-level (...) groups in a VALUES list, up to RETURNING. */
function valueTuples(text: string): string[] {
  const tuples: string[] = [];
  const end = text.search(/\bRETURNING\b/i);
  const list = end < 0 ? text : text.slice(0, end);
  let i = 0;
  while (i < list.length) {
    if (list[i] === '(') {
      const body = balanced(list, i + 1, '(', ')');
      tuples.push(body);
      i += body.length + 2;
    } else i++;
  }
  return tuples;
}

const literalsOf = (text: string) => [...text.matchAll(/'([a-z][a-z_]*)'/g)].map((m) => m[1]);

/** Types a file declares through its bell payloads: `type: 'x', title`, `type: 'x' | 'y', title` and `type XBell = 'x' | 'y'`. */
function declaredBellTypes(file: string): string[] {
  const found: string[] = [];
  for (const m of file.matchAll(/\btype\s*:\s*((?:'[a-z_]+'\s*\|?\s*)+)\s*,\s*title\b/g)) found.push(...literalsOf(m[1]));
  for (const m of file.matchAll(/\btype\s+\w*Bell\w*\s*=\s*((?:'[a-z_]+'\s*\|?\s*)+);/g)) found.push(...literalsOf(m[1]));
  return found;
}

/** Every type one source file inserts, and a note for each insert that could not be read (never silently skipped). */
export function insertedTypes(file: string): { types: string[]; unreadable: string[] } {
  const types: string[] = [];
  const unreadable: string[] = [];
  for (const m of file.matchAll(/INSERT INTO notifications\s*\(/g)) {
    const note = file.slice(m.index!, m.index! + 70).replace(/\s+/g, ' ');
    const columnsStart = m.index! + m[0].length;
    const columnsText = balanced(file, columnsStart, '(', ')');
    const typeAt = columnsText.split(',').map((c) => c.trim()).indexOf('type');
    const sqlEnd = file.indexOf('`', columnsStart);
    const afterColumns = file.slice(columnsStart + columnsText.length + 1, sqlEnd);
    const keyword = afterColumns.match(/\b(VALUES|SELECT)\b/i);
    if (typeAt < 0 || !keyword) { unreadable.push(note); continue; }

    const rest = afterColumns.slice(keyword.index! + keyword[0].length);
    const lists = /VALUES/i.test(keyword[0]) ? valueTuples(rest) : [rest.split(/\bFROM\b|\bWHERE\b|\bRETURNING\b/i)[0]];

    const after = file.slice(sqlEnd + 1).replace(/^\s*,\s*(\/\/[^\n]*\n\s*)*/, '');
    const params = after.startsWith('[') ? topLevelCommas(balanced(after, 1, '[', ']')) : null;

    for (const list of lists) {
      const element = topLevelCommas(list)[typeAt];
      if (element === undefined) { unreadable.push(note); continue; }
      const direct = element.match(/^'([a-z][a-z_]*)'$/);
      if (direct) { types.push(direct[1]); continue; }

      const param = element.match(/^\$(\d+)(::\w+)?$/);
      const value = param && params ? params[Number(param[1]) - 1] : undefined;
      const valueLiteral = value?.match(/^'([a-z][a-z_]*)'$/);
      if (valueLiteral) { types.push(valueLiteral[1]); continue; }

      const name = (value ?? element).match(/(\w+)\s*$/)?.[1];
      const assigned = name ? file.match(new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*([^;]+);`)) : null;
      const resolved = [...(assigned ? literalsOf(assigned[1]) : []), ...declaredBellTypes(file)];
      if (resolved.length === 0) unreadable.push(note);
      types.push(...resolved);
    }
  }
  return { types, unreadable };
}

function allowedByMigration(): string[] {
  const sql = fs.readFileSync(MIGRATION_118, 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  const check = sql.match(/ADD CONSTRAINT notifications_type_check CHECK \(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (!check) throw new Error('118 has no notifications_type_check CHECK');
  return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('every notification type the server inserts is allowed by notifications_type_check', () => {
  const allowed = allowedByMigration();
  const scanned = sourceFiles(SRC).map((file) => ({
    file: path.relative(SRC, file).replace(/\\/g, '/'),
    ...insertedTypes(fs.readFileSync(file, 'utf8')),
  })).filter((s) => s.types.length > 0 || s.unreadable.length > 0);

  it('reads every insert it finds: no INSERT INTO notifications is skipped for being unreadable', () => {
    expect(scanned.flatMap((s) => s.unreadable.map((u) => `${s.file}: ${u}`))).toEqual([]);
  });

  it('finds the inserts in the files known to ring the bell, so a broken scan cannot pass by finding nothing', () => {
    const files = scanned.map((s) => s.file);
    for (const known of [
      'services/invite/invite.service.ts', 'services/circle/circle-wall.service.ts', 'services/pod/pod-wall.service.ts',
      'services/poke/poke.service.ts', 'services/dm/group.service.ts', 'services/meetings/meeting.service.ts',
    ]) expect(files).toContain(known);
    expect(new Set(scanned.flatMap((s) => s.types)).size).toBeGreaterThanOrEqual(18);
  });

  it('allows every type found: none is missing from the list migration 118 restates', () => {
    const missing = scanned.flatMap((s) => s.types.filter((t) => !allowed.includes(t)).map((t) => `${s.file} inserts '${t}'`));
    expect(missing).toEqual([]);
  });

  it('knows circle_invite is inserted, and that it is allowed', () => {
    expect(scanned.find((s) => s.file === 'services/invite/invite.service.ts')?.types).toContain('circle_invite');
    expect(allowed).toContain('circle_invite');
  });

  it('would have caught migration 090: a type an insert writes that the list lacks is found, however it is written', () => {
    const literal = "await query(`INSERT INTO notifications (user_id, type, title) VALUES ($1, 'brand_new_type', $2)`, [id, title]);";
    expect(insertedTypes(literal).types).toEqual(['brand_new_type']);
    const viaParam = "await query(`INSERT INTO notifications (user_id, type, title) VALUES ($1, $2, $3)`, [id, 'another_new_type', title]);";
    expect(insertedTypes(viaParam).types).toEqual(['another_new_type']);
    const viaSelect = "await query(`INSERT INTO notifications (user_id, type, title) SELECT id, 'third_new_type', $1 FROM users`, [t]);";
    expect(insertedTypes(viaSelect).types).toEqual(['third_new_type']);
    for (const type of ['brand_new_type', 'another_new_type', 'third_new_type']) expect(allowed).not.toContain(type);
  });
});
