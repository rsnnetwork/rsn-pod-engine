-- ─── Migration 022: Integrity Gaps & Missing Hot-Path Indexes ────────────────
-- Fixes: invited_by_user_id FK missing ON DELETE, plus composite indexes
-- for high-frequency query patterns in matching/orchestration/ratings.

-- ═════════════════════════════════════════════════════════════════════════════
-- FIX 1: invited_by_user_id → ON DELETE SET NULL
-- Without this, deleting a user who invited others throws an FK violation.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_invited_by_user_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_invited_by_user_id_fkey
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- FIX 2: Missing composite indexes for hot query paths
-- ═════════════════════════════════════════════════════════════════════════════

-- Ratings given by a user, ordered by date (rating recap / history)
CREATE INDEX IF NOT EXISTS idx_ratings_from_user_date
  ON ratings(from_user_id, created_at DESC);

-- Matches by session + round + status (orchestration engine hits this ~10x per round)
CREATE INDEX IF NOT EXISTS idx_matches_session_round_status
  ON matches(session_id, round_number, status);

-- Encounter history mutual matches per session (recap analytics)
CREATE INDEX IF NOT EXISTS idx_encounter_session_mutual
  ON encounter_history(last_session_id, mutual_meet_again)
  WHERE mutual_meet_again = TRUE;
