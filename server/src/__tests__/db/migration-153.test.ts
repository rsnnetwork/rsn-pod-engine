// ─── Migration 153: calendar connections (Shirley pilot S8, D7) ──────────────────────────────────────────────────────
//
// One new table, made only when missing. Running the file twice is held by IF NOT EXISTS and was run twice for real on
// a scratch Postgres (PGlite) for the task report, with the services' own SQL against it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '153_calendar_connections.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const code = (text: string) => text.replace(/--[^\n]*/g, '');
const flat = (text: string) => code(text).replace(/\s+/g, ' ').trim();

describe('migration 153 (calendar connections)', () => {
  it('is the only file numbered 153, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '153')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('makes the table only when missing, one row per member per provider, gone with the member', () => {
    const s = flat(sql);
    expect(s).toContain('CREATE TABLE IF NOT EXISTS calendar_connections (');
    expect(s).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(s).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(s).toContain("provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'microsoft'))");
    expect(s).toContain('CONSTRAINT uq_calendar_connections_user_provider UNIQUE (user_id, provider)');
    expect(s).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('keeps tokens only sealed (bytes, never text), and no column for an event, a title or a busy time', () => {
    const s = flat(sql);
    expect(s).toContain('refresh_token_enc BYTEA NOT NULL');
    expect(s).toContain('access_token_enc BYTEA NULL');
    expect(s).toContain("status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect'))");
    expect(code(sql)).not.toMatch(/\b(refresh_token|access_token)\s+(TEXT|VARCHAR)/i);
    expect(code(sql)).not.toMatch(/title|subject|attendee|busy|summary|location/i);
  });

  it('records why migration 075\'s "no calendar integration" no longer holds', () => {
    expect(sql).toMatch(/supersedes migration 075/i);
  });

  it('only adds: no drop, delete, update, truncate or rename', () => {
    expect(code(sql).replace(/ON DELETE CASCADE/g, '')).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|RENAME|DROP|ALTER)\b/i);
  });
});
