-- server/src/db/migrations/120_request_reason_line.sql
-- REASON's own line on a meeting request, kept apart from the member's note (30 Oct 2026). Until now a request
-- had one text, user_pokes.message, into which the server wrote the member's note, REASON's "why" sentence, or
-- both run together, and every screen drew it as if the sender had written it (Stefan: "It looks like the
-- sender wrote it"). From now on message holds only what the member wrote and reason_line holds REASON's line.
-- No backfill: rows written before this keep their one text, and the server splits it when it reads them
-- (services/poke/request-text.ts). Only adds one nullable column.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE user_pokes ADD COLUMN IF NOT EXISTS reason_line TEXT;
