// ─── Migration 159: the badge an admin gives a member (21 Nov 2026) ─────────────────────────────────────────────
//
// Shradha: "can we update a premium badge to them?" users gains profile_badge, NULL or one of PROFILE_BADGES. It is
// display only and NOT users.is_premium (migration 055), which changes live-event matching. No member is given the
// badge by a migration: that is done once the owner confirms, by hand. Applied files are never edited. The file was
// also run twice for real on PGlite for the report.

import * as fs from 'fs';
import * as path from 'path';
import { PROFILE_BADGES } from '@rsn/shared';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '159_profile_badge.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

describe('migration 159 (profile badge)', () => {
  it('is the only file numbered 159, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '159')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds the badge only when missing, nullable, held to PROFILE_BADGES by a CHECK dropped before it is added', () => {
    const f = flat(sql);
    expect(f).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_badge TEXT NULL;');
    expect(f).toContain('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_badge_check;');
    expect(f).toContain(`ALTER TABLE users ADD CONSTRAINT users_profile_badge_check CHECK (profile_badge IN (${PROFILE_BADGES.map((b) => `'${b}'`).join(', ')}));`);
  });

  it('gives nobody the badge (no backfill) and never touches is_premium', () => {
    const f = flat(sql);
    expect(f).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(f).not.toMatch(/is_premium/);
  });
});
