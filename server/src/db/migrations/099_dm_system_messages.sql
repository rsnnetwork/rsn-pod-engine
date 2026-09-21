-- 099 — the meeting loop speaks in the chat (Shradha's deck, 19 Sep test, P0).
--
-- "Both saved availability, both saw a green overlapping slot, one picked it,
-- and nothing happened." Part of that was layout (fixed 21 Sep). The rest is
-- that the thread never said anything: saving availability wrote rows and told
-- nobody, so two people sat in a chat with no idea what to do next.
--
-- A system message is a row in the thread that the PRODUCT wrote, not a person:
-- "X shared times they can meet", "you are both free at ... pick one", "meeting
-- confirmed". from_user_id stays the member whose action triggered it (the
-- column is NOT NULL and there is no system user), and `kind` is what tells the
-- client to draw it as a neutral card instead of that person's bubble.
--
-- No explicit BEGIN/COMMIT: the runner wraps each file in its own transaction
-- (server/src/db/migrate.ts) and an inner COMMIT would end it early, leaving
-- the _migrations bookkeeping insert outside it. 092-098 follow the same rule.

ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';

ALTER TABLE direct_messages
  DROP CONSTRAINT IF EXISTS direct_messages_kind_check;
ALTER TABLE direct_messages
  ADD CONSTRAINT direct_messages_kind_check CHECK (kind IN ('user', 'system'));

-- What the card needs to draw itself, so the client never parses the text:
--   {"type":"availability_shared"}
--   {"type":"meeting_proposal","slots":["2026-09-24T13:00:00Z", ...]}
--   {"type":"meeting_confirmed","startAt":"...","durationMin":30,
--    "meetingType":"video","joinPath":"/meet/<conversationId>?scheduled=1&kind=video"}
ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS system_meta JSONB;

-- Dedupe state for the proposal card, so a re-save of the same overlap does not
-- post a second one. The key is the earliest future overlapping slot.
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_proposed_key TEXT;
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_proposed_at TIMESTAMPTZ;

-- "X shared times they can meet" is posted once per side, on their first share.
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS avail_shared_at_a TIMESTAMPTZ;
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS avail_shared_at_b TIMESTAMPTZ;

-- The allowlist is restated in full from 094 (the latest definition) plus the
-- new type. Any later migration that touches this constraint must carry every
-- value below forward, or inserts of the missing type start failing in prod.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message',
                  'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted',
                  'circle_reaction', 'circle_comment', 'circle_reply',
                  'incoming_call', 'availability_updated', 'meeting_proposed'));

-- The thread reads newest-first per conversation; kind is filtered in the app,
-- not in SQL, so no new index is needed here.
