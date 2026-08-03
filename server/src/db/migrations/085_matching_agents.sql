-- Migration 085: Matching Agents (Wave 2 core, 3 Aug 2026)
--
-- Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
-- Source: assets/RSN 30 july 2026.pdf — "every person creates active reasons for
-- meeting people, then the network is continually searched for those people."
--
-- Design decisions:
--   * user_intent_profiles stays ONE row per user (its PK is user_id) and keeps
--     being "who I am" — the offer side. Agents own "what I want", many per
--     user. The scorer already split wantSources() from offerSources(), so this
--     is a clean cut rather than a rewrite.
--   * agent_matches PERSISTS scores. Today matching is computed in JS on every
--     request and thrown away, which is exactly why per-agent counts
--     ("Developer: 3 matches") cannot be rendered. Counts read this table.
--   * archive, never hard-delete — same discipline as circles.archived_at.
--   * user_pokes.agent_id records which agent produced an introduction, so
--     exclusions are per-agent (D3): asking to meet someone via Developer must
--     not blank them from Investor, where they may fit for another reason.
--   * max_active_agents ships UNENFORCED (D2). The column and its admin control
--     exist so switching limits on later is configuration, not a rebuild.

BEGIN;

CREATE TABLE IF NOT EXISTS matching_agents (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Deliberately NOT unique: several concurrent agents per member is the feature.
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          VARCHAR(80) NOT NULL CHECK (length(trim(label)) > 0),
  -- Free text the scorer tokenizes, same shape as the want-side columns it
  -- reads on users today.
  want_text      TEXT NOT NULL DEFAULT '' CHECK (length(want_text) <= 2000),
  -- Optional structured slice, same shape as user_intent_profiles.matching_intent.
  intent         JSONB NOT NULL DEFAULT '{}',
  matching_tags  TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'archived')),
  last_matched_at TIMESTAMPTZ NULL,
  archived_at    TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The dashboard's read path: every active agent for one member.
CREATE INDEX IF NOT EXISTS idx_matching_agents_user
  ON matching_agents (user_id, status);
CREATE INDEX IF NOT EXISTS idx_matching_agents_tags
  ON matching_agents USING GIN (matching_tags);

CREATE TABLE IF NOT EXISTS agent_matches (
  agent_id         UUID NOT NULL REFERENCES matching_agents(id) ON DELETE CASCADE,
  candidate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score            NUMERIC(5,4) NOT NULL,
  reason           TEXT NOT NULL DEFAULT '',
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, candidate_user_id)
);

-- "3 potential matches", and the agent detail list, both read this order.
CREATE INDEX IF NOT EXISTS idx_agent_matches_rank
  ON agent_matches (agent_id, score DESC);

-- Which agent produced an introduction. Nullable: every poke sent before this
-- migration, and every poke sent from a profile rather than an agent, has none.
ALTER TABLE user_pokes
  ADD COLUMN IF NOT EXISTS agent_id UUID NULL REFERENCES matching_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_pokes_agent
  ON user_pokes (agent_id) WHERE agent_id IS NOT NULL;

-- Ships unenforced; NULL means "no limit" so existing rows need no backfill.
ALTER TABLE user_entitlements
  ADD COLUMN IF NOT EXISTS max_active_agents INTEGER NULL;

COMMIT;
