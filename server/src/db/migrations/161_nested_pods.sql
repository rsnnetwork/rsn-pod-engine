-- Stefan, 22 Nov 2026: "an event is in a pod", "a pod can be a main pod, like a circle", and for "in a pod inside a
-- pod, must people be in the parent pod first?": "no, dependent on choice of pod owner".
--
-- 1. pods.parent_pod_id: the main pod this pod is inside, or NULL for a pod that stands alone (every pod today). One
--    level only (nested-pods.service.ts says so, under a lock on the rows): a main pod holds pods, and a pod inside one
--    holds none. A pod is never inside itself (the CHECK). Deleting a main pod for good leaves its pods standing alone
--    (SET NULL); archiving one changes nothing here.
-- 2. pods.inner_pods_members_only: the main pod's director's choice that people must be active members of it to join
--    the pods inside it. Off for every pod (Stefan's "no"). Nobody already in a pod is ever taken out by it.
--
-- Additive and safe to run twice. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE pods ADD COLUMN IF NOT EXISTS parent_pod_id UUID NULL REFERENCES pods(id) ON DELETE SET NULL;
ALTER TABLE pods ADD COLUMN IF NOT EXISTS inner_pods_members_only BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE pods DROP CONSTRAINT IF EXISTS pods_parent_pod_not_self_check;
ALTER TABLE pods ADD CONSTRAINT pods_parent_pod_not_self_check CHECK (parent_pod_id IS NULL OR parent_pod_id <> id);

CREATE INDEX IF NOT EXISTS idx_pods_parent_pod_id ON pods (parent_pod_id) WHERE parent_pod_id IS NOT NULL;
