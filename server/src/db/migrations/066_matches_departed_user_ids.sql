-- Migration 066 — WS2 (27 May remaining work): trio round-end ratings must
-- include departed members.
--
-- demoteParticipantFromMatch re-canonicalises the participant slots when a
-- trio member departs (leave / host pull-back / grace expiry / kick), so the
-- departed user's id was lost from the match row and round-end rating
-- emission couldn't have the survivors rate them. Track departed ids
-- additively. RATING-ONLY: never read by matching, presence, or uniqueness
-- logic — slots stay canonical for all of those.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS departed_user_ids UUID[] NOT NULL DEFAULT '{}';
