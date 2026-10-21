-- server/src/db/migrations/102_join_request_sign_in_origin.sql
-- The site a join request was made on (7 Oct 2026). Someone who asks to join on the preview and is
-- approved gets an email whose link opens the preview, not the live app. The request remembers the
-- origin the form was sent from, kept only when it is one of our own sites and not the main app (the
-- code checks that on the way in, and again when a link is built). NULL means the main app: every
-- request made before this column existed, and every request made on the live app.
-- Only adds: nullable, no default, nothing rewritten or removed.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS sign_in_origin TEXT;
