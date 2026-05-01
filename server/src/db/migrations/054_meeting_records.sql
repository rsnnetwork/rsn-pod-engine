-- Migration 054: Meeting Records (Phase 2 of 1 May 2026 architectural plan)
--
-- Stefan's 1 May spec, items 3+4: counts are computed live and inconsistent
-- ("3 meetings → 15 mutual matches", "Claus had 6 matches → becomes 4 after
-- re-entering"). Pre-Phase-2, recap counts were derived via JOINs over
-- matches × ratings × encounter_history at every render, with three
-- different SQL bodies (UI / email / host recap) producing three slightly
-- different numbers. The encounter_history.mutual_meet_again field also
-- mutated as later rounds finalised, so refreshing the recap mid-event
-- changed the displayed numbers.
--
-- meeting_records is the canonical per-meeting record. One row per
-- (session, round, user, partner). Written exactly once when the round's
-- rating window closes (via finalizeRoundRatings). Updated only when the
-- partner submits their rating (recomputes is_mutual). Never mutated by
-- anything else.
--
-- All recap consumers refactor to read from this table. encounter_history
-- becomes purely cross-session aggregate, no longer driving per-event
-- counts.

BEGIN;

CREATE TABLE IF NOT EXISTS meeting_records (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id            UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number          INTEGER NOT NULL,
  match_id              UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating_given          INTEGER CHECK (rating_given IS NULL OR (rating_given BETWEEN 1 AND 5)),
  meet_again_self       BOOLEAN, -- this user's meet_again vote
  meet_again_partner    BOOLEAN, -- partner's meet_again vote
  is_mutual             BOOLEAN GENERATED ALWAYS AS (
                          meet_again_self IS TRUE AND meet_again_partner IS TRUE
                        ) STORED,
  is_recap_eligible     BOOLEAN NOT NULL DEFAULT TRUE,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(user_id != partner_id),
  UNIQUE(session_id, round_number, user_id, partner_id)
);

-- Inbox / recap queries by user.
CREATE INDEX IF NOT EXISTS idx_meeting_records_user
  ON meeting_records(user_id, session_id);

-- Three-metric aggregations need fast COUNT DISTINCT on partner_id.
CREATE INDEX IF NOT EXISTS idx_meeting_records_user_partner
  ON meeting_records(user_id, session_id, partner_id);

-- Session-wide stats (host recap, admin export).
CREATE INDEX IF NOT EXISTS idx_meeting_records_session
  ON meeting_records(session_id, round_number);

-- Backfill from existing matches × ratings. One row per (user, partner)
-- pair, per round, per session. The pair expansion uses LATERAL with
-- unnest on the participants array so trios produce 3 user×partner edges
-- per match (A↔B, A↔C, B↔C), matching the runtime semantics.
INSERT INTO meeting_records (
  session_id, round_number, match_id, user_id, partner_id,
  rating_given, meet_again_self, meet_again_partner, is_recap_eligible, recorded_at
)
SELECT
  m.session_id,
  m.round_number,
  m.id AS match_id,
  pair.user_id,
  pair.partner_id,
  r_self.quality_score AS rating_given,
  r_self.meet_again AS meet_again_self,
  r_partner.meet_again AS meet_again_partner,
  TRUE AS is_recap_eligible,
  COALESCE(m.ended_at, m.started_at, m.created_at, NOW()) AS recorded_at
FROM matches m
CROSS JOIN LATERAL (
  -- Build all unordered pairs of participants for this match.
  -- 2-person: (A,B) and (B,A). 3-person: 6 directed edges.
  SELECT pa.uid AS user_id, pb.uid AS partner_id
  FROM unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS pa(uid)
  CROSS JOIN unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS pb(uid)
  WHERE pa.uid IS NOT NULL AND pb.uid IS NOT NULL AND pa.uid != pb.uid
) AS pair
LEFT JOIN ratings r_self ON r_self.match_id = m.id
                        AND r_self.from_user_id = pair.user_id
                        AND r_self.to_user_id = pair.partner_id
LEFT JOIN ratings r_partner ON r_partner.match_id = m.id
                           AND r_partner.from_user_id = pair.partner_id
                           AND r_partner.to_user_id = pair.user_id
WHERE m.status NOT IN ('cancelled', 'scheduled')
ON CONFLICT (session_id, round_number, user_id, partner_id) DO NOTHING;

COMMIT;
