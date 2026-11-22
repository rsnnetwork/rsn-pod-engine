// ─── Migration 160: the notification email outbox, its deliveries, last_seen_at, the digest switches (22 Nov 2026) ──
//
// Stefan: emails only while away, at most X a day with the rest the next morning, and a weekly digest. Applied files
// are never edited. The file was also run for real, twice, on a throwaway Postgres with every earlier migration
// applied (the task report has the run).

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '160_notification_email_outbox.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
const flat = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const tableOf = (name: string) => {
  const f = flat(sql);
  const start = f.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  return f.slice(start, f.indexOf(');', start));
};

describe('migration 160 (notification email outbox)', () => {
  it('is the only file numbered 160, and has no top-level transaction control (the runner wraps each file)', () => {
    const numbers = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '160')).toHaveLength(1);
    expect(transactionControl(sql)).toEqual([]);
  });

  it('makes the outbox only when missing: a uuid id, created_at, the member (CASCADE) and the actor (SET NULL)', () => {
    const t = tableOf('notification_email_outbox');
    expect(t).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(t).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(t).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(t).toContain('actor_id UUID NULL REFERENCES users(id) ON DELETE SET NULL');
    expect(t).toContain("CHECK (kind IN ('meeting_request', 'meeting_accepted', 'direct_message', 'invite'))");
    expect(t).toContain("CHECK (status IN ('queued', 'sending', 'sent', 'held', 'digesting', 'digested', 'skipped', 'dropped', 'failed'))");
    expect(t).toContain('send_after TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('keeps one row per member, kind and source, and indexes the due rows, a member\'s rows, held, claimed and age', () => {
    const f = flat(sql);
    expect(f).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_email_outbox_once ON notification_email_outbox (user_id, kind, source_id);');
    expect(f).toContain("CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_due ON notification_email_outbox (send_after) WHERE status = 'queued';");
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_member ON notification_email_outbox (user_id, status, created_at);');
    expect(f).toContain("CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_held ON notification_email_outbox (created_at) WHERE status = 'held';");
    expect(f).toContain("CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_claimed ON notification_email_outbox (claimed_at) WHERE status IN ('sending', 'digesting');");
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_created ON notification_email_outbox (created_at);');
  });

  it('makes the deliveries, whose partial unique index is the one-per-day claim of the daily and weekly emails', () => {
    const t = tableOf('notification_email_deliveries');
    expect(t).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(t).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(t).toContain('user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(t).toContain("CHECK (kind IN ('instant', 'daily', 'weekly'))");
    expect(t).toContain('local_day DATE NOT NULL');
    const f = flat(sql);
    expect(f).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_email_deliveries_once ON notification_email_deliveries (user_id, kind, local_day) WHERE kind IN ('daily', 'weekly');");
    expect(f).toContain('CREATE INDEX IF NOT EXISTS idx_notification_email_deliveries_member_day ON notification_email_deliveries (user_id, kind, local_day);');
  });

  it('adds users.last_seen_at only when missing, nullable, with no backfill', () => {
    expect(flat(sql)).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;');
    expect(sql).not.toMatch(/UPDATE users/);
  });

  it('seeds the daily switch on and the weekly switch OFF, leaving an existing row as an admin set it', () => {
    expect(flat(sql)).toContain(
      "INSERT INTO email_config (email_type, enabled, subject) VALUES ('daily_digest', TRUE, 'Yesterday on REASON'), ('weekly_digest', FALSE, 'Your week on REASON') ON CONFLICT (email_type) DO NOTHING;",
    );
  });

  it('holds no address, name or message text in its own columns (the payload holds what the email says)', () => {
    expect(tableOf('notification_email_outbox')).not.toMatch(/\bemail\b|display_name|content/);
    expect(tableOf('notification_email_deliveries')).not.toMatch(/\bemail\b|display_name|content/);
  });
});
