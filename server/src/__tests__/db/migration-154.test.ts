// ─── Migration 154: the event link (Stefan, 11 Nov 2026) ──────────────────────────────────────────────────────────────
//
// Three nullable columns on sessions with one CHECK, a unique index per name and number, the counters and the old links,
// and a backfill that gives every existing event 'rsn' and the next number in the order made, a tail when not public.
// Run twice for real on PGlite and on a scratch Postgres 17 for the task report (the second run changes nothing).

import * as fs from 'fs';
import * as path from 'path';
import { eventLinkNeedsTailSql } from '../../services/session/event-link.service';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '154_event_links.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 154 (event links)', () => {
  it('is the only file numbered 154, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '154')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the columns only when missing, with one CHECK holding the name, the number and the tail to the shared rule', () => {
    const f = flat(sql);
    for (const col of ['link_name TEXT', 'link_number INTEGER', 'link_tail TEXT']) {
      expect(f).toContain(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ${col};`);
    }
    expect(f).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_event_link_check')");
    expect(f).toContain("link_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(link_name) BETWEEN 2 AND 40");
    expect(f).toContain("link_tail IS NULL OR link_tail ~ '^[a-km-np-z][2-9a-km-np-z]{5}$'");
  });

  it('one event per name and number; counters and old links are new tables with an id, a created_at and ON DELETE stated', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_event_link ON sessions (link_name, link_number) WHERE link_name IS NOT NULL;');
    expect(f).toContain('CREATE TABLE IF NOT EXISTS event_link_counters ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE');
    expect(f).toContain('CREATE TABLE IF NOT EXISTS event_link_aliases ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT NOT NULL UNIQUE, session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE');
    expect((f.match(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/g) ?? []).length).toBe(2);
  });

  it('backfills only events without a link, as rsn, in the order made, and raises every counter to what was given', () => {
    const f = flat(sql);
    expect(f).toContain('WHERE s.link_name IS NULL');
    expect(f).toContain('row_number() OVER (ORDER BY s.created_at, s.id) AS n');
    expect(f).toContain("SET link_name = 'rsn', link_number = taken.top + ordered.n");
    expect(f).toContain('SET last_number = GREATEST(event_link_counters.last_number, EXCLUDED.last_number)');
    expect(code(sql).replace(/ON DELETE CASCADE/g, '')).not.toMatch(/\b(DELETE|TRUNCATE|DROP|RENAME)\b/i);
  });

  it('writes out the service\'s tail rule exactly (the backfill and every later open agree on who gets a tail)', () => {
    const rule = (text: string) => text.replace(/\s+/g, ' ').replace(/el_p|el_c/g, 'x').replace(/\bp\b|\bc\b/g, 'x').trim();
    const service = rule(eventLinkNeedsTailSql('s'));
    const start = flat(sql).indexOf('COALESCE(NOT ( ((s.visibility IS NOT NULL');
    const end = flat(sql).indexOf(' AS secret');
    expect(start).toBeGreaterThan(0);
    expect(rule(flat(sql).slice(start, end))).toBe(service);
  });

  it('draws each tail from gen_random_uuid()\'s random bytes 0 to 5: a letter first (24), then 32 symbols without 0, o, 1, l', () => {
    const f = flat(sql);
    expect(f).toContain("substr('abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 0) % 24 + 1, 1)");
    for (const i of [1, 2, 3, 4, 5]) {
      expect(f).toContain(`substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, ${i}) % 32 + 1, 1)`);
    }
  });
});
