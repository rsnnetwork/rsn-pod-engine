-- server/src/db/migrations/123_meeting_feedback.sql
-- Feedback after a meeting (30 Oct 2026, item 5c): "After a meeting ends, show a short prompt asking how it went
-- and if there were any problems. Save the answers in the admin panel."
--
-- The answers go into meeting_outcomes (migration 101), which the person brief already reads, so it keeps reading
-- one table. Each answer after a meeting names its meeting: one answer per person per meeting, and a second press
-- edits it (the unique index is the upsert's conflict target). `source` says where it was given: after a 1:1
-- meeting, an event or a direct call. The rows the profile's outcome sheet writes (one on production today, and
-- every new one from POST /people/:userId/outcome) have no meeting and keep a NULL source: that route is unchanged.
-- `problems` and `problem_text` answer "Any problems?". The lists in the CHECKs are the shared MEETING_PROBLEMS and
-- MEETING_FEEDBACK_SOURCES (migration-123.test.ts holds them together).
--
-- Additive only: every existing column is kept, and nothing is backfilled. Each constraint is added once, by name.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS meeting_id UUID NULL REFERENCES meetings(id) ON DELETE SET NULL;
ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS source TEXT NULL;
ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS problems TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE meeting_outcomes ADD COLUMN IF NOT EXISTS problem_text TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_outcomes_source_check') THEN
    ALTER TABLE meeting_outcomes ADD CONSTRAINT meeting_outcomes_source_check
      CHECK (source IS NULL OR source IN ('meeting', 'event', 'instant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_outcomes_problems_check') THEN
    ALTER TABLE meeting_outcomes ADD CONSTRAINT meeting_outcomes_problems_check
      CHECK (problems <@ ARRAY['audio', 'video', 'connection', 'behaviour', 'other']::TEXT[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_outcomes_problem_text_check') THEN
    ALTER TABLE meeting_outcomes ADD CONSTRAINT meeting_outcomes_problem_text_check
      CHECK (problem_text IS NULL OR char_length(problem_text) <= 1000);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_outcomes_user_meeting
  ON meeting_outcomes (user_id, meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_meeting ON meeting_outcomes (meeting_id);
-- The admin list, newest first, a page at a time (keyset on the time and the id).
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_created ON meeting_outcomes (created_at DESC, id DESC);
