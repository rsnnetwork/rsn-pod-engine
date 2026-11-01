-- 125: who can join an event (T11, 30 Oct review item 6.1; L17).
--
-- sessions.visibility is the event's own access: 'public', 'public_with_approval' or 'private'. NULL (every
-- existing event, and every event production's form makes) keeps following the pod exactly as before. No backfill.
--
-- event_join_requests holds a person's request for a place in an event that asks the host to approve each
-- place. A request is not a participant row, so no count, capacity or room admission ever reads it as "in".
-- These rows are approval records (CLAUDE.md section 15): never delete them in a cleanup.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so
-- running the file twice changes nothing.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visibility TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_visibility_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_visibility_check
      CHECK (visibility IS NULL OR visibility IN ('public', 'public_with_approval', 'private'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_visibility ON sessions (visibility) WHERE visibility IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_join_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  message     TEXT NULL CHECK (message IS NULL OR char_length(message) <= 500),
  decided_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_join_requests_pending ON event_join_requests (session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_event_join_requests_user ON event_join_requests (user_id);
