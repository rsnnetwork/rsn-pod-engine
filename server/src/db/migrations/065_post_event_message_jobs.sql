-- Migration 065: Post-Event Broadcast Messaging
-- A durable job per (event, send) and one tracked row per recipient so the
-- worker is idempotent and survives restarts. Per-recipient UNIQUE(job,user)
-- plus status make double-sends impossible.

BEGIN;

CREATE TYPE post_event_message_job_status AS ENUM (
  'pending', 'processing', 'completed', 'completed_with_errors', 'failed'
);
CREATE TYPE post_event_message_recipient_status AS ENUM (
  'pending', 'sent', 'failed', 'skipped'
);
CREATE TYPE post_event_message_bucket AS ENUM (
  'stayed', 'left_early', 'could_not_join', 'no_show'
);

CREATE TABLE post_event_message_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users(id),
  status          post_event_message_job_status NOT NULL DEFAULT 'pending',
  total_recipients   INTEGER NOT NULL DEFAULT 0,
  sent_count         INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Only one active (non-terminal) job per event at a time.
CREATE UNIQUE INDEX uniq_active_job_per_session
  ON post_event_message_jobs(session_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_pem_jobs_status ON post_event_message_jobs(status);
CREATE INDEX idx_pem_jobs_session ON post_event_message_jobs(session_id);

CREATE TABLE post_event_message_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES post_event_message_jobs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket          post_event_message_bucket NOT NULL,
  status          post_event_message_recipient_status NOT NULL DEFAULT 'pending',
  message_id      UUID,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  UNIQUE(job_id, user_id)
);

CREATE INDEX idx_pem_recipients_job ON post_event_message_recipients(job_id);
CREATE INDEX idx_pem_recipients_pending
  ON post_event_message_recipients(job_id) WHERE status = 'pending';

COMMIT;
