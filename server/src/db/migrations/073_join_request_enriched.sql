-- ─── Migration: 073_join_request_enriched ────────────────────────────────────
-- Preload: cache the LinkedIn enrichment result on the join request at admin
-- approval time, so an approved member's profile card is fully populated the
-- instant they log in. The ~50s web-search lookup runs during the approval →
-- login gap (off the critical path) and is copied onto the user's
-- inferred_profile at first login (see verifyMagicLink). Additive + idempotent.

ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS enriched JSONB;
