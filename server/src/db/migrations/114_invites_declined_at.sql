-- server/src/db/migrations/114_invites_declined_at.sql
-- When an invitee said no (26 Oct 2026). A decline was written as status 'revoked', the very value an organiser's
-- withdrawal gets, so a pod's organisers could never tell "declined" from "withdrawn" and the invite list that
-- should say who declined could not (client feedback, 25 Oct). This column keeps the moment of the invitee's own
-- "no". The status stays 'revoked' on purpose: production's bell and Invites page map only that value, and they
-- keep working; a new `declined` enum value would break both until the client changed.
-- No backfill: an old 'revoked' row cannot be told from a withdrawal, and converting rows would need the
-- production-data rules (CLAUDE.md section 15). Only adds one nullable column.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE invites ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
