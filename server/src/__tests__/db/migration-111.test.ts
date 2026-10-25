// ─── Migration 111: an event's format (26 Oct 2026) ──────────────────────────────────────────────
//
// sessions.event_format holds what an event IS (speed networking, a video meeting…): the live engine branches
// on it, and lists and the reaper can filter on it. Every existing row reads speed_networking, which is what
// actually ran (no backfill: a production "Video Meeting" made before this ran as speed networking). The
// CHECK list is the shared EVENT_FORMAT_KEYS written out. This file is applied in production and is never
// edited: a new format gets a NEW migration that restates the CHECK, and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { EVENT_FORMAT_KEYS } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const FILE = '111_event_format.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

describe('migration 111 (sessions.event_format)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only adds: one column and one index, nothing dropped, deleted or rewritten', () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME)\b/i);
    const alters = flat.match(/ALTER TABLE [^;]*/gi) ?? [];
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/^ALTER TABLE sessions ADD COLUMN IF NOT EXISTS event_format\b/i);
  });

  it('adds event_format as text, never null, speed_networking by default, checked against the five formats', () => {
    expect(flat).toMatch(
      /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS event_format TEXT NOT NULL DEFAULT 'speed_networking' CHECK \(event_format IN \([^)]*\)\);/i,
    );
  });

  it('its CHECK list is the shared list of formats', () => {
    const check = flat.match(/CHECK \(event_format IN \(([^)]*)\)\)/i);
    expect(check).not.toBeNull();
    const allowed = [...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...EVENT_FORMAT_KEYS].sort());
  });

  it('indexes the column, only when the index is missing', () => {
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_sessions_event_format ON sessions \(event_format\);/i);
    const creates = flat.match(/CREATE (UNIQUE )?(TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates).toHaveLength(1);
  });
});
