-- 092 — exact meeting time + duration on a 1:1 conversation (W6, 7 Sep 2026).
--
-- Scheduling stored only a daypart ("2026-09-10:evening"), so a confirmed
-- meeting had no real start time, no duration, and no way to show each person
-- the time in their own timezone or to send a calendar invite. A confirmed
-- meeting now pins an absolute instant + a duration; each client renders the
-- instant in its own local time, and both people get an .ics invite by email.
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_start_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meeting_duration_min INTEGER;
