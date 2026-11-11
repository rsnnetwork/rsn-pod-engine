-- A member's public profile link (Shirley pilot S6, 11 Nov 2026; plan decision D5).
--
-- Opt-in: a member who wants to show their profile to people not on REASON yet makes a link, /p/<token>. Anyone holding
-- it sees the public card only (never a private field, an entity, a circle or pod, or a way to contact them).
--
--   public_profile_token             16 random bytes in base64url (22 characters, 128 bits), never derived from the
--                                    member's id. NULL while the member has no link. Revoking clears it; making a new
--                                    link replaces it, so an old link, its screenshots and its shares stop at once.
--                                    Closing the account clears it too, so a reopened account starts with no link.
--   public_profile_token_created_at  when the current link was made; NULL with the token.
--
-- The token is read only by its owner (GET /api/users/me/public-link) and by the public page's lookup. It is not in
-- getUserById's column list, so no profile read (the owner's, an admin's, another member's) ever carries it.
--
-- No BEGIN/COMMIT: the runner wraps each file in its own transaction. Safe to run twice: every statement is guarded.

ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile_token VARCHAR(22) NULL
  CHECK (public_profile_token IS NULL OR public_profile_token ~ '^[A-Za-z0-9_-]{22}$');
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile_token_created_at TIMESTAMPTZ NULL;

-- The public page finds its member by the token; at most one member holds any token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_profile_token
  ON users (public_profile_token) WHERE public_profile_token IS NOT NULL;
