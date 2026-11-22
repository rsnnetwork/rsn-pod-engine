// ─── Migration 158: a member's standard meeting request (21 Nov 2026) ────────────────────────────────────────────
//
// Stefan: "I should be able in my profile to state my 'standard message' and preferred format". users gains
// meet_note_default (at most MEET_NOTE_MAX characters, NULL for REASON's own note) and meet_format_default (one of
// MEETING_FORMATS, the same list as user_pokes.preferred_format in migration 101, NULL for the standard one). Applied
// files are never edited. The file was also run twice for real on PGlite for the report.

import * as fs from 'fs';
import * as path from 'path';
import { MEET_NOTE_MAX, MEETING_FORMATS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '158_meet_request_defaults.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const quoted = (list: readonly string[]) => list.map((k) => `'${k}'`).join(', ');

describe('migration 158 (standard meeting request)', () => {
  it('is the only file numbered 158, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '158')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the note only when missing, nullable, held to MEET_NOTE_MAX characters by a CHECK dropped before it is added', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS meet_note_default TEXT NULL;');
    expect(f).toContain('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_meet_note_default_length;');
    expect(f).toContain(`ALTER TABLE users ADD CONSTRAINT users_meet_note_default_length CHECK (char_length(meet_note_default) <= ${MEET_NOTE_MAX});`);
  });

  it('adds the format only when missing, nullable, held to the MEETING_FORMATS keys, the same list as migration 101', () => {
    const f = flat(sql);
    const keys = quoted(MEETING_FORMATS.map((m) => m.key));
    expect(f).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS meet_format_default TEXT NULL;');
    expect(f).toContain('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_meet_format_default_check;');
    expect(f).toContain(`ALTER TABLE users ADD CONSTRAINT users_meet_format_default_check CHECK (meet_format_default IN (${keys}));`);
    const m101 = flat(fs.readFileSync(path.join(MIGRATIONS, fs.readdirSync(MIGRATIONS).find((n) => n.startsWith('101_'))!), 'utf8'));
    expect(m101).toContain(`CHECK (preferred_format IN (${keys}))`);
  });

  it('writes no rows: nobody is given a note or a format', () => {
    expect(flat(sql)).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});
