-- Migration 084: Flip poke_email's seeded default from false to true, and
-- backfill it on every existing row (pokes-notification-prefs wiring,
-- 23 Jul 2026 — owner decision: "wire the toggles, default ON").
--
-- 053 baked poke_email: false into the notification_prefs column DEFAULT,
-- but nothing ever enforced it — sendPoke/acceptPoke's email sends only
-- checked users.notify_email + email_config (082) until this change wired
-- shouldSendEmail(..., 'poke') into poke.service.ts. So every row, old and
-- new, has carried an explicit poke_email: false that nobody consciously
-- chose; it was an invisible seeded default for a toggle that never worked.
-- Flipping it here means nobody is being silently opted out of a real,
-- working feature — the Settings "Pokes" email toggle becomes a genuine
-- opt-out starting today, default on.
--
-- Additive-safe + idempotent: the ALTER only changes what future INSERTs
-- default to; the UPDATE unconditionally re-sets the same key to the same
-- value on every row, so re-running this migration is a no-op the second
-- time.

BEGIN;

ALTER TABLE users
  ALTER COLUMN notification_prefs SET DEFAULT
  '{
    "dm_bell": true,
    "dm_email": true,
    "poke_bell": true,
    "poke_email": true,
    "group_bell": true,
    "group_email": false,
    "invite_bell": true,
    "invite_email": true,
    "report_resolved_bell": true,
    "report_resolved_email": false
  }'::jsonb;

UPDATE users
SET notification_prefs = jsonb_set(notification_prefs, '{poke_email}', 'true');

COMMIT;
