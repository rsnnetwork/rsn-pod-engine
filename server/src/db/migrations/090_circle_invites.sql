-- 090_circle_invites.sql — circle-level invites (13 Aug 2026, C3).
--
-- Stefan: "Circle-level invites also needed, not just pod-level." Pods and
-- events have had invites since 001; circles (P3, July) did not. A circle
-- invite mirrors the pod path: same table, same code, same email, same
-- acceptance flow, with a circle id instead of a pod id. Accepting one joins
-- the circle (circles are open-join, so this is a doorway, not a gate).
--
-- PostgreSQL 17: ADD VALUE is allowed inside the runner's transaction as long
-- as the new label is not used in the same transaction — it is not.
ALTER TYPE invite_type ADD VALUE IF NOT EXISTS 'circle';

ALTER TABLE invites ADD COLUMN IF NOT EXISTS circle_id UUID
  REFERENCES circles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_invites_circle_id ON invites(circle_id) WHERE circle_id IS NOT NULL;
