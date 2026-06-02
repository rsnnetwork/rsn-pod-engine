-- Migration 060: Acting-as-host opt-in/opt-out (12 May 2026 review item 1)
--
-- Stefan #1: hosts/cohosts/super_admin need a per-event toggle to choose
-- whether they "Join as host" or "Join as participant". Today the role
-- system auto-derives host capability from the global role (super_admin)
-- or session_cohosts membership — there's no way for a user who is
-- normally a host to attend an event as a participant.
--
-- This migration adds a nullable BOOLEAN column on session_participants
-- to express the override. NULL means "follow the role default"; TRUE
-- means "act as host on this event"; FALSE means "join as participant".
--
-- Purely additive — no defaults, NULL allowed. Existing rows untouched,
-- behavior unchanged unless a user explicitly toggles. Safe on a live DB.

BEGIN;

ALTER TABLE session_participants
  ADD COLUMN acting_as_host BOOLEAN;

COMMENT ON COLUMN session_participants.acting_as_host IS
  'Phase M (12 May spec item 1) — per-event opt-in/opt-out for host UI. '
  'NULL = use role default (super_admin/event_host/cohost auto-host). '
  'TRUE = explicit opt-in to host (admin promotes self). '
  'FALSE = explicit opt-out (super_admin/host attends as participant).';

COMMIT;
