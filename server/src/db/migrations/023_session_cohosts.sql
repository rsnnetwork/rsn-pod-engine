-- Migration 023: Session Co-Hosts
-- Allows hosts to delegate co-host or moderator roles during live events.

BEGIN;

CREATE TABLE IF NOT EXISTS session_cohosts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'co_host' CHECK (role IN ('co_host', 'moderator')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by  UUID REFERENCES users(id),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_cohosts_session ON session_cohosts(session_id);
CREATE INDEX IF NOT EXISTS idx_session_cohosts_user ON session_cohosts(user_id);

COMMIT;
