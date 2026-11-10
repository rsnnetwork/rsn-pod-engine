-- 136: a lightweight guest identity for event attendees (Part 2, Task 3, 10 Nov 2026)
--
-- Someone who joins an event from its link gets a users row like everyone else (rooms, chat, ratings and video all
-- key on users.id), marked account_kind = 'event_guest'. Member-only parts of RSN refuse a guest: the authenticate
-- middleware reads the kind from this column (never from a token), the dm:* socket events refuse a guest socket, and
-- every discovery query keeps only account_kind = 'member'. Approving the guest's platform join request turns the
-- row into a member.
--
-- Every existing row becomes 'member' through the column default, so production behaves exactly as before: nothing
-- creates a guest until the event link entry ships.
--
-- guest_first_session_id is the event the guest first came in through; it is kept as a plain reference and cleared
-- if that event is deleted.
--
-- Additive and idempotent. No BEGIN/COMMIT: the runner wraps this file in its own transaction.
-- 132-134 belong to Part 1 and 135-142 are reserved for Part 2; the runner tracks files by name, so the gap is fine.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_kind TEXT NOT NULL DEFAULT 'member'
    CONSTRAINT users_account_kind_check CHECK (account_kind IN ('member', 'event_guest'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS guest_first_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_event_guests_created
  ON users (created_at)
  WHERE account_kind = 'event_guest';
