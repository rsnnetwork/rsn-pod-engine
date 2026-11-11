// ─── Migration 144: an event's image and its time zone (10 Nov spec, Part 3 Task 1; K1) ─────────────────────────
//
// sessions gains timezone (an IANA zone, backfilled from the host's zone when Postgres knows it, else UTC, then NOT
// NULL DEFAULT 'UTC') and the image columns (the cut picture, its type and crop, the picture it was cut from and its
// type, when it last changed), all NULL-able so every existing event has no image. Applied files are never edited: a
// later change is a NEW migration and this test follows it.
//
// Running the file twice, and the backfill (a host in 'Europe/London' gives 'Europe/London', a host with NULL or
// 'garbage' gives 'UTC'), were run for real on a scratch Postgres (PGlite) for the task report; here the guards and
// the statements' shape are held.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/144_event_image_and_time_zone.sql'), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 144 (event image and time zone)', () => {
  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the zone and the six image columns, every one guarded and NULL-able at first', () => {
    const f = flat(sql);
    for (const column of [
      'timezone VARCHAR(64)', 'image_blob BYTEA', 'image_mime VARCHAR(40)', 'image_crop JSONB',
      'image_source_blob BYTEA', 'image_source_mime VARCHAR(40)', 'image_updated_at TIMESTAMPTZ',
    ]) {
      expect(f).toContain(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ${column};`);
    }
    expect((f.match(/ADD COLUMN/g) ?? []).length).toBe((f.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
  });

  it('backfills from the host zone only when Postgres knows it, else UTC, and only rows without one', () => {
    const f = flat(sql);
    expect(f).toContain('UPDATE sessions s SET timezone = u.timezone FROM users u WHERE s.timezone IS NULL AND u.id = s.host_user_id AND u.timezone IN (SELECT name FROM pg_timezone_names);');
    expect(f).toContain("UPDATE sessions SET timezone = 'UTC' WHERE timezone IS NULL;");
    // The host backfill runs before the UTC one, and both before the column is made NOT NULL.
    expect(f.indexOf('SET timezone = u.timezone')).toBeLessThan(f.indexOf("SET timezone = 'UTC'"));
    expect(f.indexOf("SET timezone = 'UTC'")).toBeLessThan(f.indexOf('SET NOT NULL'));
  });

  it('then defaults to UTC and refuses NULL', () => {
    const f = flat(sql);
    expect(f).toContain("ALTER TABLE sessions ALTER COLUMN timezone SET DEFAULT 'UTC';");
    expect(f).toContain('ALTER TABLE sessions ALTER COLUMN timezone SET NOT NULL;');
  });

  it('deletes, drops, truncates and renames nothing, and writes only rows with no zone yet', () => {
    const statements = code(sql);
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    const updates = statements.match(/\bUPDATE\s+sessions\b[^;]*;/gi) ?? [];
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update).toMatch(/timezone IS NULL/);
  });
});
