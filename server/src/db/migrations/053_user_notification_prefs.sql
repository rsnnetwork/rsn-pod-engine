-- Migration 053: User Notification Preferences (Phase J of chat-fix-and-dm-system, 1 May 2026)
--
-- Per-user toggles for what notifications fire and via what channel.
-- JSONB with sensible defaults so unset users get the standard behaviour.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT
  '{
    "dm_bell": true,
    "dm_email": true,
    "poke_bell": true,
    "poke_email": false,
    "group_bell": true,
    "group_email": false,
    "invite_bell": true,
    "invite_email": true,
    "report_resolved_bell": true,
    "report_resolved_email": false
  }'::jsonb;

COMMIT;
