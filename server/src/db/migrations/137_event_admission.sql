-- 137: admission per event (Part 2, Task 4, 10 Nov 2026)
--
-- Who gets a place on an event, beside who sees it (sessions.visibility):
--   admission_mode NULL         today's rules, exactly (every existing event stays NULL)
--   'open'                      any active account, a guest from the event's link included
--   'approval'                  the audience, invitees, allowed emails and code holders register; everyone else requests
--   'restricted'                "Invitation only": organisers, admins, invitees, allowed emails and redeemed codes; the
--                               pod or circle audience is NOT admitted by membership alone. The live room re-checks this
--                               on every join, so an email taken off the list keeps its person out.
-- Setting a mode on an event with no visibility also gives it one (the service, in the same transaction), so a mode never
-- sits on a NULL-visibility event: sessions_admission_needs_visibility holds that.
--
-- event_admission_entries: the allowed emails (lower-cased and trimmed, one row per address per event; a revoked row is
-- restored when the address is added again). event_admission_codes: one-time codes, stored only as a keyed hash
-- (HMAC-SHA256 with the server's secret) and their last four symbols; the plaintext is shown once, when generated.
--
-- Additive and idempotent. No BEGIN/COMMIT: the runner wraps this file in its own transaction.
-- 135-142 are reserved for Part 2; the runner tracks files by name, so a gap is fine.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admission_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_admission_mode_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_admission_mode_check
      CHECK (admission_mode IS NULL OR admission_mode IN ('open', 'approval', 'restricted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_admission_needs_visibility') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_admission_needs_visibility
      CHECK (admission_mode IS NULL OR visibility IS NOT NULL);
  END IF;
END $$;

ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS admitted_via TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_participants_admitted_via_check') THEN
    ALTER TABLE session_participants ADD CONSTRAINT session_participants_admitted_via_check
      CHECK (admitted_via IS NULL OR admitted_via IN ('open', 'approval', 'invite', 'allow_list', 'code', 'audience', 'admin'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_admission_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  email       TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 255),
  group_key   TEXT,
  source      TEXT NOT NULL CHECK (source IN ('paste', 'csv', 'organiser')),
  added_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, email)
);

-- Who is listed anywhere for an address (a member's own events, a guest arriving from a link).
CREATE INDEX IF NOT EXISTS idx_event_admission_entries_email ON event_admission_entries (email);

CREATE TABLE IF NOT EXISTS event_admission_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  code_last4   TEXT NOT NULL,
  label        TEXT CHECK (label IS NULL OR length(label) <= 80),
  group_key    TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ,
  redeemed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at  TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, code_hash)
);

-- The codes still waiting to be used (the organisers' counts).
CREATE INDEX IF NOT EXISTS idx_event_admission_codes_open
  ON event_admission_codes (session_id) WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- Whether a person holds a redeemed code for an event (the register rule and the live-room gate ask on every join).
CREATE INDEX IF NOT EXISTS idx_event_admission_codes_redeemer
  ON event_admission_codes (session_id, redeemed_by) WHERE redeemed_by IS NOT NULL;
