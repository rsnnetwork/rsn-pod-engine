-- server/src/db/migrations/128_circle_join_policy.sql
-- Who can join a circle (30 Oct review, item 7.5; L22). The person who runs a circle chooses Open (anyone on
-- REASON joins at once, as every circle does today) or Closed (people ask, and the circle's managers let them in).
--
-- 1. circles.join_policy, 'open' or 'closed', NOT NULL with the constant default 'open': every existing circle stays
--    open (production has four, all open-join), and adding the column is a metadata-only change.
-- 2. circle_join_requests: one row per ask. Requests live in a table of their own rather than as a status on
--    circle_members, so every existing reader of circle_members (wall posting, invites' "already a member", the
--    member list and counts, is_member) keeps meaning "member" with no new filter to forget. One pending request per
--    person per circle (a partial unique index, the conflict target the service names); a second index serves the
--    managers' list of pending requests, a third a person's latest answer for a circle.
--
-- Additive and safe to run twice: IF NOT EXISTS everywhere and the CHECK guarded by its name. No BEGIN/COMMIT: the
-- runner wraps this file in its own transaction.

ALTER TABLE circles ADD COLUMN IF NOT EXISTS join_policy VARCHAR(20) NOT NULL DEFAULT 'open';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'circles_join_policy_check') THEN
    ALTER TABLE circles ADD CONSTRAINT circles_join_policy_check CHECK (join_policy IN ('open', 'closed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS circle_join_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id   UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  decided_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_join_requests_pending
  ON circle_join_requests (circle_id, user_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_circle_join_requests_circle_pending
  ON circle_join_requests (circle_id, created_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_circle_join_requests_user
  ON circle_join_requests (user_id, circle_id, created_at DESC);
