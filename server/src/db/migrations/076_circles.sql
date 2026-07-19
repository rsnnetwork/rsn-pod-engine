-- Migration 076: Circles (REASON v1 Phase 3a, 19 Jul 2026)
--
-- Stefan's definition, locked 17 Jul: a circle is a group of people with the
-- same intent/type (community, the WHO); a pod is an activity flow (the WHAT
-- HAPPENS). Circles↔pods are MANY-TO-MANY (a pod is attached to circles,
-- never contained by one) and circles can nest (parent_circle_id; cycle and
-- depth rules enforced in the service — admin-only writes). Admin-created v1.
--
-- Counters are denormalised and maintained transactionally (no COUNT(*) on
-- hot paths); they are display data, never authorization data. Circles are
-- ARCHIVED, never hard-deleted. Full architecture:
-- docs/superpowers/plans/2026-07-19-circles-wall-architecture.md

BEGIN;

CREATE TABLE IF NOT EXISTS circles (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(120) NOT NULL CHECK (length(trim(name)) >= 2),
  description      TEXT CHECK (length(description) <= 2000),
  parent_circle_id UUID NULL REFERENCES circles(id) ON DELETE SET NULL,
  created_by       UUID NOT NULL REFERENCES users(id),
  member_count     INTEGER NOT NULL DEFAULT 0,
  post_count       INTEGER NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Name unique per nesting level, case-insensitive ("Founders" can exist once
-- at top level and once inside another circle, but not twice as siblings).
CREATE UNIQUE INDEX IF NOT EXISTS idx_circles_name_per_parent
  ON circles (lower(name), COALESCE(parent_circle_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id  UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (circle_id, user_id)
);

-- "My circles" is a hot path (nav, home feed scoping later).
CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id);

CREATE TABLE IF NOT EXISTS circle_pods (
  circle_id  UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  pod_id     UUID NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (circle_id, pod_id)
);

-- Reverse lookup: which circles does this pod belong to (pod page, P3b).
CREATE INDEX IF NOT EXISTS idx_circle_pods_pod ON circle_pods(pod_id);

COMMIT;
