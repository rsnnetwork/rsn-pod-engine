-- Migration 095: Availability-change dot (W-meet, 8 Sep 2026)
--
-- Ali's ask: when one side of a conversation changes their meeting availability,
-- the OTHER side should see a notification dot on the calendar icon telling them
-- "they changed something here" — and it must survive a refresh, not be a
-- one-shot socket flag (RSN clients reload mid-flow constantly).
--
-- We track, per side of the conversation, when they last changed availability
-- and when they last opened the scheduler. The dot shows for a user when the
-- PARTNER's availability changed more recently than the user last looked.
--
-- The migration runner wraps each file in its own BEGIN/COMMIT, so no explicit
-- transaction here (matches 091/093/094).

ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS avail_updated_at_a  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS avail_updated_at_b  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduler_seen_at_a TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduler_seen_at_b TIMESTAMPTZ;
