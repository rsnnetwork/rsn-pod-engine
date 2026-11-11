-- 146: extra matching questions for an event (10 Nov 2026 spec, Part 3 Task 5; spec section 02; plan K5)
--
-- An organiser may ask up to five extra questions per event ("Which sector?", "What stage is your company at?"), each
-- with 2 to 8 answers the organiser writes, one answer or several. Guests answer them on the RSN Call link, members
-- when they register on the event page. The matcher reads the answers as a soft preference only:
--
--   "Matching questions are soft preferences. They only choose among the meetings the event already allows. A block, a
--   report, an inviter and the person they invited, and the event's group rules always win, and so does the no-repeat
--   rule. Questions never make a meeting that would otherwise be refused, never leave someone unmatched, and never
--   cause a repeat."
--
-- Two tables, both empty until an organiser saves a question:
--   event_matching_questions  the event's questions: key, prompt, one answer or several, same or different answers
--                             preferred, required or not, the answers offered (JSONB [{key,label}], config SQL never
--                             filters on) and their order
--   event_question_answers    each person's answer to each question (option keys), visible only to them and to the
--                             event's organisers
--
-- An event with no event_matching_questions rows is matched exactly as before. Everything goes with its event (ON
-- DELETE CASCADE); a removed question takes its answers with it; a person's answers go with their account; who last
-- changed a question survives as NULL when that account goes.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so running
-- the file twice changes nothing.

CREATE TABLE IF NOT EXISTS event_matching_questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL CHECK (key ~ '^[a-z0-9_]{1,32}$'),
  prompt      TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 120),
  kind        TEXT NOT NULL CHECK (kind IN ('single', 'multiple')),
  prefer      TEXT NOT NULL CHECK (prefer IN ('same', 'different')),
  required    BOOLEAN NOT NULL DEFAULT FALSE,
  options     JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 8),
  position    INT NOT NULL DEFAULT 0,
  updated_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, key)
);

CREATE TABLE IF NOT EXISTS event_question_answers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES event_matching_questions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_keys TEXT[] NOT NULL CHECK (cardinality(option_keys) BETWEEN 1 AND 8),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, user_id)
);

-- One person's answers in an event (the matcher's read for the people it pairs, the person's own read).
CREATE INDEX IF NOT EXISTS idx_event_question_answers_person ON event_question_answers (session_id, user_id);
