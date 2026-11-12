-- Calendar free/busy (Shirley pilot S8, 12 Nov 2026; brief RSN 10; plan decision D7).
--
-- This supersedes migration 075's "Deliberately no calendar integration (time windows only)": the product owner approved
-- an OPTIONAL Google or Microsoft connection on 11 Nov 2026, so a member can see when they are busy while they offer
-- times to meet. It reads busy and free times of the primary calendar only; booking never needs it.
--
-- One row per member per provider. What is kept, and what never is:
--   account_email      the calendar account's address, shown in Settings so the member knows which account is connected
--   scopes             what the provider granted (checked at connect; the calendar permission is required)
--   refresh_token_enc  the refresh token, sealed with AES-256-GCM under CALENDAR_TOKEN_KEY: IV (12 bytes) | tag (16) |
--                      ciphertext, bound to the member, the provider and the token's kind (services/calendar-sync)
--   access_token_enc   the current access token, sealed the same way; NULL once the grant needs reconnecting
--   access_expires_at  when that access token runs out (refreshed a minute before)
--   key_version        which key sealed them (1 today; room for a later key rotation)
--   status             active, or needs_reconnect when the provider stopped accepting REASON's access
--   last_error         a short code only (invalid_grant, forbidden, key), never a provider's message
--   connected_at       when this grant was made (a reconnect resets it)
-- Busy times are NEVER written to the database (they live a few minutes in Redis), nor any event's title, attendees,
-- place or notes, which are never even read.
--
-- Disconnecting deletes the row (and so the tokens); closing an account deletes its rows in code, because a close only
-- marks the account and the ON DELETE CASCADE below fires on a hard delete alone. The audit_log keeps
-- calendar.connected / calendar.disconnected with the provider only.
--
-- Only adds: one new table, made only when missing. Safe to run twice.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_email      VARCHAR(320) NULL,
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  refresh_token_enc  BYTEA NOT NULL CHECK (octet_length(refresh_token_enc) > 28),
  access_token_enc   BYTEA NULL CHECK (access_token_enc IS NULL OR octet_length(access_token_enc) > 28),
  access_expires_at  TIMESTAMPTZ NULL,
  key_version        SMALLINT NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  status             VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reconnect')),
  last_error         VARCHAR(40) NULL,
  last_used_at       TIMESTAMPTZ NULL,
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_calendar_connections_user_provider UNIQUE (user_id, provider)
);
-- Every read is by member (and provider): the unique constraint's index, which user_id leads, serves them all.
