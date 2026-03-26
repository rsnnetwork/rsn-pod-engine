-- ─── Migration: 026_join_request_admin_notes ──────────────────────────────────
-- Add admin_notes column for internal notes separate from review decision notes.

ALTER TABLE join_requests ADD COLUMN IF NOT EXISTS admin_notes TEXT;
