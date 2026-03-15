-- Fix: ratings unique constraint must include to_user_id for trio support.
-- The old UNIQUE(match_id, from_user_id) only allows one rating per user per match,
-- but in a 3-person room a user needs to rate 2 different partners.

ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_match_id_from_user_id_key;
ALTER TABLE ratings ADD CONSTRAINT ratings_match_from_to_unique UNIQUE (match_id, from_user_id, to_user_id);
