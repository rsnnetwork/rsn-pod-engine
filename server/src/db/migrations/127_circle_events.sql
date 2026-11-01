-- 127: an event for a whole circle (T13, 30 Oct review item 6.5; L20).
--
-- sessions.circle_id names the circle an event is for. The event still lives in its pod (pod_id stays NOT NULL);
-- the circle's active members are its audience on top of the pod's: they see it and register without joining the
-- pod (event-access.ts). NULL, which every existing event is and every event production's form makes, keeps
-- today's answers. No backfill.
--
-- Circles are archived, never deleted, so ON DELETE SET NULL only ever leaves an event to its pod.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so
-- running the file twice changes nothing.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS circle_id UUID NULL REFERENCES circles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_circle ON sessions (circle_id) WHERE circle_id IS NOT NULL;
