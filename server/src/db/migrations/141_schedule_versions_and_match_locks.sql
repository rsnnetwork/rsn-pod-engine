-- 141: published versions of the matching board, and the live matches that follow them
--      (10 Nov 2026 spec, Part 2 Task 9; spec sections 06, 07, 12)
--
-- The organisers' draft (migration 140) is private. Publishing freezes it into a numbered version that nobody edits
-- again; the live `matches` table is then the latest version written out for the rounds not yet started (Key
-- decision D4). An event with no row here takes today's path: nothing in this file changes a stored row.
--   event_schedule_versions   one row per published version: who published it (NULL: the product, repairing the
--                             live event by itself), why, the note shown to the organisers, how many people it
--                             changed meetings for, and the rounds and rooms as they were published (`snapshot`,
--                             { rounds: [{ round, rooms: [{ room, userIds, locked, override, fallback }] }] }).
--                             A version is immutable: a trigger refuses any change to it, except the publisher
--                             becoming NULL when their account is deleted (the foreign key's ON DELETE SET NULL).
--   matches.locked            the meeting was locked on the board: the host's live Re-match keeps it, and live swap
--                             and exclude refuse it.
--   matches.schedule_version  the published version the row was written from (NULL: made by the engine live, as
--                             before).
--   matches.assignment_source how the board seated the room: 'auto' (the engine), 'manual' (an organiser), 'repair'
--                             (the product, after someone arrived or left). NULL for a row not from the board.
-- The three columns have constant defaults (FALSE, NULL, NULL), so adding them rewrites no row.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so
-- running the file twice changes nothing.

CREATE TABLE IF NOT EXISTS event_schedule_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version        INT NOT NULL CHECK (version >= 1),
  published_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  automatic      BOOLEAN NOT NULL DEFAULT FALSE,
  reason         TEXT NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  note           TEXT NULL CHECK (note IS NULL OR char_length(note) <= 500),
  impacted_count INT NOT NULL DEFAULT 0 CHECK (impacted_count >= 0),
  snapshot       JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, version)
);

-- The versions someone published (the account-deletion cascade sets published_by to NULL through this index).
CREATE INDEX IF NOT EXISTS idx_event_schedule_versions_published_by
  ON event_schedule_versions (published_by) WHERE published_by IS NOT NULL;

CREATE OR REPLACE FUNCTION event_schedule_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.automatic IS DISTINCT FROM OLD.automatic
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.impacted_count IS DISTINCT FROM OLD.impacted_count
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.published_by IS DISTINCT FROM OLD.published_by AND NEW.published_by IS NOT NULL) THEN
    RAISE EXCEPTION 'A published schedule version cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_schedule_versions_immutable ON event_schedule_versions;
CREATE TRIGGER trg_event_schedule_versions_immutable
  BEFORE UPDATE ON event_schedule_versions
  FOR EACH ROW EXECUTE FUNCTION event_schedule_versions_immutable();

ALTER TABLE matches ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS schedule_version INT NULL;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS assignment_source TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_assignment_source_check') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_assignment_source_check
      CHECK (assignment_source IS NULL OR assignment_source IN ('auto', 'manual', 'repair'));
  END IF;
END $$;
