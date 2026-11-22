-- server/src/db/migrations/159_profile_badge.sql
-- Shradha (21 Nov 2026): "we are onboarding people now to the platform, once it's done, can we update a premium badge
-- to them?" An admin gives a member a badge, shown beside their name wherever members are listed. It is display only:
-- it is NOT users.is_premium (migration 055), which changes live-event matching. Nothing about how anyone is matched,
-- what they may do or what they pay reads this column.
--
-- users.profile_badge: NULL (no badge) or 'premium'. The CHECK names every badge there is, so a new one is a new
-- migration that restates it by name. Read only on the member's own row and beside their public card, never filtered
-- on, so no index. Safe to run twice. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_badge TEXT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_badge_check;
ALTER TABLE users ADD CONSTRAINT users_profile_badge_check CHECK (profile_badge IN ('premium'));
