-- 140: the matching board's private draft (10 Nov 2026 spec, Part 2 Task 8; spec sections 06, 07, 12)
--
-- An organiser plans who meets whom in each round of an event on a board before (and between rounds of) the
-- live event. This file holds the draft only: publishing it as a numbered version, and the live `matches` table
-- following the latest published version, come with Task 9. An event with no rows here takes today's path.
--   event_schedules               one row per event: the draft's revision (bumped by every write, so two
--                                 organisers editing at once never overwrite each other) and the published version
--   event_schedule_assignments    who sits in which room of which round; one seat per person per round
--                                 (UNIQUE), so nobody can be stored in two rooms of a round
--   event_schedule_room_locks     a meeting the organiser fixed: generate and redistribute never touch it
--   event_schedule_absences       someone arriving late (absent until a round) or not coming (absent from a round on)
--
-- The basket (people of a round who have no seat) is never stored: it is worked out from the event's people,
-- these seats and these absences, so no write to the board can lose anyone.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so
-- running the file twice changes nothing.

CREATE TABLE IF NOT EXISTS event_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  revision          INT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  published_version INT NULL CHECK (published_version IS NULL OR published_version >= 1),
  generated_at      TIMESTAMPTZ NULL,
  updated_by        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_schedule_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number INT NOT NULL CHECK (round_number >= 1),
  room_number  INT NOT NULL CHECK (room_number >= 1),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  source       TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'repair')),
  override     BOOLEAN NOT NULL DEFAULT FALSE,
  fallback     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, round_number, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_schedule_assignments_room
  ON event_schedule_assignments (session_id, round_number, room_number);
-- A person's seats across events (the account-deletion cascade and "where am I seated" reads).
CREATE INDEX IF NOT EXISTS idx_event_schedule_assignments_user ON event_schedule_assignments (user_id);

CREATE TABLE IF NOT EXISTS event_schedule_room_locks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number INT NOT NULL CHECK (round_number >= 1),
  room_number  INT NOT NULL CHECK (room_number >= 1),
  locked_by    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, round_number, room_number)
);

CREATE TABLE IF NOT EXISTS event_schedule_absences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('late', 'no_show')),
  from_round INT NOT NULL CHECK (from_round >= 1),
  to_round   INT NULL CHECK (to_round IS NULL OR to_round >= from_round),
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_schedule_absences_user ON event_schedule_absences (user_id);
