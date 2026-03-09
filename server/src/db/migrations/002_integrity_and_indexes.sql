-- ─── Migration 002: Data Integrity Fixes + Performance Indexes ──────────────
-- Adds missing ON DELETE behaviors for foreign keys and composite indexes
-- for production-scale query performance.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1: Foreign Key ON DELETE Fixes
-- ═════════════════════════════════════════════════════════════════════════════

-- matches.participant_a_id → ON DELETE CASCADE
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_participant_a_id_fkey;
ALTER TABLE matches ADD CONSTRAINT matches_participant_a_id_fkey
  FOREIGN KEY (participant_a_id) REFERENCES users(id) ON DELETE CASCADE;

-- matches.participant_b_id → ON DELETE CASCADE
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_participant_b_id_fkey;
ALTER TABLE matches ADD CONSTRAINT matches_participant_b_id_fkey
  FOREIGN KEY (participant_b_id) REFERENCES users(id) ON DELETE CASCADE;

-- ratings.from_user_id → ON DELETE CASCADE
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_from_user_id_fkey;
ALTER TABLE ratings ADD CONSTRAINT ratings_from_user_id_fkey
  FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ratings.to_user_id → ON DELETE CASCADE
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_to_user_id_fkey;
ALTER TABLE ratings ADD CONSTRAINT ratings_to_user_id_fkey
  FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE;

-- encounter_history.user_a_id → ON DELETE CASCADE
ALTER TABLE encounter_history DROP CONSTRAINT IF EXISTS encounter_history_user_a_id_fkey;
ALTER TABLE encounter_history ADD CONSTRAINT encounter_history_user_a_id_fkey
  FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE;

-- encounter_history.user_b_id → ON DELETE CASCADE
ALTER TABLE encounter_history DROP CONSTRAINT IF EXISTS encounter_history_user_b_id_fkey;
ALTER TABLE encounter_history ADD CONSTRAINT encounter_history_user_b_id_fkey
  FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE;

-- invites.inviter_id → ON DELETE CASCADE
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_inviter_id_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_inviter_id_fkey
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE;

-- sessions.host_user_id → ON DELETE SET NULL (preserve session history)
ALTER TABLE sessions ALTER COLUMN host_user_id DROP NOT NULL;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_host_user_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_host_user_id_fkey
  FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2: Performance Composite Indexes
-- ═════════════════════════════════════════════════════════════════════════════

-- Sessions by pod, ordered by date (chronological session listing)
CREATE INDEX IF NOT EXISTS idx_sessions_pod_scheduled
  ON sessions(pod_id, scheduled_at DESC);

-- Pod members by user + status (list user's pods)
CREATE INDEX IF NOT EXISTS idx_pod_members_user_status
  ON pod_members(user_id, status);

-- Pod members by pod + status (count active members)
CREATE INDEX IF NOT EXISTS idx_pod_members_pod_status
  ON pod_members(pod_id, status);

-- Session participants by session + status (lobby readiness check)
CREATE INDEX IF NOT EXISTS idx_session_participants_session_status
  ON session_participants(session_id, status);

-- Session participants by user + session (participant lookup)
CREATE INDEX IF NOT EXISTS idx_session_participants_user_session
  ON session_participants(user_id, session_id);

-- Matches by participant pair (anti-duplicate check in matching engine)
CREATE INDEX IF NOT EXISTS idx_matches_pair
  ON matches(participant_a_id, participant_b_id);

-- Ratings received by user, ordered by date (recap queries)
CREATE INDEX IF NOT EXISTS idx_ratings_to_user_date
  ON ratings(to_user_id, created_at DESC);

-- Invites by pod + status (pod invite listing)
CREATE INDEX IF NOT EXISTS idx_invites_pod_status
  ON invites(pod_id, status);

-- Pods by visibility + status (public pod discovery)
CREATE INDEX IF NOT EXISTS idx_pods_visibility_status
  ON pods(visibility, status);

-- Users by verified + status (filtered user search)
CREATE INDEX IF NOT EXISTS idx_users_verified_status
  ON users(email_verified, status);

-- Active pod members filtered index (fast active member queries)
CREATE INDEX IF NOT EXISTS idx_pod_members_active
  ON pod_members(pod_id) WHERE status = 'active';
