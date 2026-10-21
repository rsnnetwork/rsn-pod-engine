-- server/src/db/migrations/103_join_request_linkedin_optional.sql
-- LinkedIn is optional on a join request (21 Oct 2026). The client, 19 Oct: "LinkedIn should not be
-- required. Recommend LinkedIn, but let people add it later." The column was NOT NULL (migration 003), so
-- a request without an address could not be stored. Now it can: the form leaves the address out and the
-- server stores NULL. The live form still sends one every time, so requests from the live app are unchanged.
-- Only lifts the constraint: no row is touched, and an empty string some older rows hold stays as it is
-- (the screens read an empty address the same as none). Running it again changes nothing.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE join_requests ALTER COLUMN linkedin_url DROP NOT NULL;
