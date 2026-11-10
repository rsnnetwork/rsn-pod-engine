-- 139: the RSN Call link's code per event (Part 2 foundation, Task 6, 11 Nov 2026; spec 04)
--
-- Every event gets one link anyone can open (shared/src/events/call-link.ts): /call/<call_code>. The code is 10 symbols
-- from a 32-symbol alphabet (digits and lower-case letters without i, l, o, u), 50 bits from the operating system's
-- random source, and unique across events. A new event gets one when it is created; an existing event gets one the
-- first time someone asks for its link (services/session/call-link.service.ts, ensureCallCode). An organiser can
-- rotate it: the old link then stops working at once. NULL until then, so every existing row is untouched.
--
-- The link's 6-digit entry code reuses magic_links (migration 131's code_hash and code_attempts) with
-- purpose = 'event_entry' and target_id = the event: no new table. purpose has no CHECK, so no change is needed there.
--
-- The email that carries the entry code has an admin switch like every other email (email_config), seeded on;
-- ON CONFLICT DO NOTHING keeps a switch an admin has already set.
--
-- Additive and idempotent. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS call_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_call_code_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_call_code_check
      CHECK (call_code IS NULL OR call_code ~ '^[0-9a-hjkmnp-tv-z]{10}$');
  END IF;
END $$;

-- One event per code, and the lookup every open of a link makes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_call_code ON sessions (call_code) WHERE call_code IS NOT NULL;

-- The newest entry link of an address for an event (the code check reads it on every try).
CREATE INDEX IF NOT EXISTS idx_magic_links_event_entry
  ON magic_links (email, target_id, created_at DESC)
  WHERE purpose = 'event_entry';

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('event_entry_code', TRUE, 'Your code for {eventTitle}')
ON CONFLICT (email_type) DO NOTHING;
