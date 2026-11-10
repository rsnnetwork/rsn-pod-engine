-- 138: matching groups and round rules for an event (10 Nov 2026 spec, Part 2 Task 5; spec sections 05, 02, 07)
--
-- An organiser may sort an event's people into groups they name (Founders and Funders, Mentors and Mentees…) and
-- say, per round or run of rounds, who may meet whom. Four tables, all empty until an organiser saves groups:
--   event_groups              the event's groups (key, label, description, order)
--   event_matching_rules      one row per event: the required group question, multiple groups or one, and what
--                             happens to people a rule leaves without a partner
--   event_round_rules         a rule for rounds from_round..to_round: open, across groups, or listed pairs
--   event_participant_groups  which group(s) each person is in for this event, and who put them there
--
-- A group belongs to the event only: it is never read from an account's platform standing or profile, and it
-- grants no permission (spec 05, "Critical distinction"). An event with no event_groups rows is matched exactly
-- as before. Everything goes with its event (ON DELETE CASCADE), and a person's memberships go with their
-- account; who changed what survives as NULL when that account goes.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so
-- running the file twice changes nothing.

CREATE TABLE IF NOT EXISTS event_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,32}$'),
  label       TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  description TEXT NULL CHECK (description IS NULL OR char_length(description) <= 200),
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, key)
);

CREATE TABLE IF NOT EXISTS event_matching_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  group_question     TEXT NOT NULL DEFAULT 'Which group are you in?' CHECK (char_length(group_question) <= 120),
  allow_multiple     BOOLEAN NOT NULL DEFAULT FALSE,
  imbalance_fallback TEXT NOT NULL DEFAULT 'leave_unmatched'
                       CHECK (imbalance_fallback IN ('leave_unmatched', 'same_group_meeting')),
  updated_by         UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_round_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_round    INT NOT NULL CHECK (from_round >= 1),
  to_round      INT NOT NULL CHECK (to_round >= from_round),
  mode          TEXT NOT NULL CHECK (mode IN ('open', 'cross_group', 'custom')),
  allowed_pairs TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, from_round)
);

CREATE TABLE IF NOT EXISTS event_participant_groups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id            UUID NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  assigned_by         TEXT NOT NULL CHECK (assigned_by IN ('self', 'organiser', 'invitation')),
  assigned_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_event_participant_groups_person ON event_participant_groups (session_id, user_id);
-- A group's removal deletes its memberships through the cascade, which looks them up by group.
CREATE INDEX IF NOT EXISTS idx_event_participant_groups_group ON event_participant_groups (group_id);
