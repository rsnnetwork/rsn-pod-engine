-- Migration: 009_purge_and_reset
-- Description: Purge ALL data except 3 super_admin users. One-time platform reset.
-- Keeper emails: im@mister-raw.com, sa@mister-raw.com, alihamza891840@gmail.com

-- ─── Step 1: Clear all relationship and activity data ──────────────────────

DELETE FROM audit_log;
DELETE FROM encounter_history;
DELETE FROM ratings;
DELETE FROM matches;
DELETE FROM session_participants;
DELETE FROM sessions;
DELETE FROM invites;
DELETE FROM pod_members;
DELETE FROM pods;
DELETE FROM magic_links;
DELETE FROM refresh_tokens;
DELETE FROM user_subscriptions;
DELETE FROM user_entitlements;

-- ─── Step 2: Delete all users except the 3 keepers ────────────────────────

DELETE FROM users
WHERE LOWER(email) NOT IN (
  'im@mister-raw.com',
  'sa@mister-raw.com',
  'alihamza891840@gmail.com'
);

-- ─── Step 3: Ensure all 3 keepers are super_admin + active ────────────────

UPDATE users
SET role = 'super_admin', status = 'active', updated_at = NOW()
WHERE LOWER(email) IN (
  'im@mister-raw.com',
  'sa@mister-raw.com',
  'alihamza891840@gmail.com'
);

-- ─── Step 4: Re-create subscriptions & entitlements for keepers ────────────
-- (They were deleted in step 1, need to be re-inserted)

INSERT INTO user_subscriptions (user_id, plan, status)
SELECT id, 'free', 'active' FROM users
WHERE LOWER(email) IN ('im@mister-raw.com', 'sa@mister-raw.com', 'alihamza891840@gmail.com')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO user_entitlements (user_id)
SELECT id FROM users
WHERE LOWER(email) IN ('im@mister-raw.com', 'sa@mister-raw.com', 'alihamza891840@gmail.com')
ON CONFLICT (user_id) DO NOTHING;

-- ─── Step 5: Ensure approved join_requests for all 3 ──────────────────────
-- So the registration gate never blocks them

DELETE FROM join_requests;

INSERT INTO join_requests (full_name, email, linkedin_url, reason, status, reviewed_by, review_notes)
SELECT
  COALESCE(u.display_name, u.email),
  u.email,
  COALESCE(u.linkedin_url, ''),
  'Platform super admin',
  'approved',
  u.id,
  'Auto-approved: super admin'
FROM users u
WHERE LOWER(u.email) IN ('im@mister-raw.com', 'sa@mister-raw.com', 'alihamza891840@gmail.com');
