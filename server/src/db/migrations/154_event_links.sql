-- 154: the event link (Stefan, 11 Nov 2026): /events/<name>-<n>, and /events/<name>-<n>-<tail> for an event that is not
-- public.
--
-- The organiser chooses the name; each event under a name gets that name's next number, counted across all events
-- (event_link_counters, one row per name, raised by one INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so two events
-- made at the same instant under one name wait for each other's row lock and never share a number; the unique index on
-- (link_name, link_number) holds it besides). An event that is not public (private, invitation-only, or in a closed
-- circle) carries a random tail of 6 symbols, the first a letter, from digits 2-9 and the letters without l and o, so
-- its link cannot be guessed from its neighbours' numbers (shared/src/events/event-link.ts).
--
-- A link the event had before (it was renamed, or became public and dropped its tail) is kept in event_link_aliases
-- and still leads to the event, except a link without a tail once the event is no longer public: that one stops
-- (services/session/event-link.service.ts decides, on every read). Rotating the call link also rotates the tail and
-- forgets every old link that had one.
--
-- sessions.call_code_private (controller ruling, 12 Nov 2026): TRUE when the event's call code was given while the event
-- was not public. A code that was not (FALSE, every new code of a public event and the default) opens the event only
-- while it is public: once the event is private or invitation-only, its old /call/<code> links are the same 404 as its
-- bare event link, and the event gets a new code, given while private. The backfill marks today's codes of events that
-- are not public as given while private (they were shared while the event was private), and every other code public.
--
-- Every existing event gets a link here: the name 'rsn' (the platform's own: every event so far was RSN's), numbered in
-- the order the events were made (created_at, then id), a tail for each one that is not public, from gen_random_uuid()'s
-- random bytes (the first 6 bytes of a version 4 UUID are all random). The 'rsn' counter then starts above them.
--
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction. Safe to run twice: every statement is guarded, and
-- the backfill only reads events that have no link yet.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS link_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS link_number INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS link_tail TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS call_code_private BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_event_link_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_event_link_check CHECK (
      (link_name IS NULL AND link_number IS NULL AND link_tail IS NULL)
      OR (link_name IS NOT NULL AND link_number IS NOT NULL
          AND link_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(link_name) BETWEEN 2 AND 40
          AND link_number BETWEEN 1 AND 999999999
          AND (link_tail IS NULL OR link_tail ~ '^[a-km-np-z][2-9a-km-np-z]{5}$'))
    );
  END IF;
END $$;

-- One event per name and number, and the lookup every open of an event link makes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_event_link ON sessions (link_name, link_number) WHERE link_name IS NOT NULL;
-- The default name for a new event: the one its pod's latest event uses.
CREATE INDEX IF NOT EXISTS idx_sessions_pod_link_name ON sessions (pod_id, created_at DESC) WHERE link_name IS NOT NULL;

-- The last number each name has given.
CREATE TABLE IF NOT EXISTS event_link_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(name) BETWEEN 2 AND 40),
  last_number INTEGER NOT NULL CHECK (last_number BETWEEN 0 AND 999999999),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The links an event had before. `slug` as it was written ('rsn-3', 'rsn-3-k7m2q9'); `secret` when it had a tail.
CREATE TABLE IF NOT EXISTS event_link_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 999999999),
  secret BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_link_aliases_session ON event_link_aliases (session_id, name);
-- The check that a number is not held by an old link (takeEventLinkNumber reads name and number).
CREATE INDEX IF NOT EXISTS idx_event_link_aliases_name_number ON event_link_aliases (name, number);

-- Every existing event without a link: 'rsn', in the order made, a tail when not public (the rule of
-- eventLinkNeedsTailSql in services/session/event-link.service.ts, written out here as it stands today). NULL-safe: a
-- NULL visibility is tested before IN (NULL IN (...) is NULL), and anything still unknown gets a tail.
WITH taken AS (
  SELECT GREATEST(
    COALESCE((SELECT MAX(link_number) FROM sessions WHERE link_name = 'rsn'), 0),
    COALESCE((SELECT MAX(number) FROM event_link_aliases WHERE name = 'rsn'), 0),
    COALESCE((SELECT last_number FROM event_link_counters WHERE name = 'rsn'), 0)
  ) AS top
),
ordered AS (
  SELECT s.id,
         row_number() OVER (ORDER BY s.created_at, s.id) AS n,
         COALESCE(NOT (
           ((s.visibility IS NOT NULL AND s.visibility IN ('public', 'public_with_approval'))
             OR (s.visibility IS NULL AND EXISTS (SELECT 1 FROM pods p WHERE p.id = s.pod_id AND p.visibility = 'public')))
           AND s.admission_mode IS DISTINCT FROM 'restricted'
           AND NOT (s.circle_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM circles c WHERE c.id = s.circle_id AND c.join_policy = 'closed'))
         ), TRUE) AS secret,
         decode(replace(gen_random_uuid()::text, '-', ''), 'hex') AS r
    FROM sessions s
   WHERE s.link_name IS NULL
)
UPDATE sessions s
   SET link_name = 'rsn',
       link_number = taken.top + ordered.n,
       link_tail = CASE WHEN ordered.secret THEN
         substr('abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 0) % 24 + 1, 1)
         || substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 1) % 32 + 1, 1)
         || substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 2) % 32 + 1, 1)
         || substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 3) % 32 + 1, 1)
         || substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 4) % 32 + 1, 1)
         || substr('23456789abcdefghijkmnpqrstuvwxyz', get_byte(ordered.r, 5) % 32 + 1, 1)
       END,
       call_code_private = ordered.secret
  FROM ordered, taken
 WHERE s.id = ordered.id;

-- Each name's counter at least the highest number it has given (a link now, or an old one).
INSERT INTO event_link_counters (name, last_number)
SELECT name, MAX(number)
  FROM (SELECT link_name AS name, link_number AS number FROM sessions WHERE link_name IS NOT NULL
        UNION ALL
        SELECT name, number FROM event_link_aliases) given
 GROUP BY name
ON CONFLICT (name) DO UPDATE
  SET last_number = GREATEST(event_link_counters.last_number, EXCLUDED.last_number),
      updated_at = NOW();
