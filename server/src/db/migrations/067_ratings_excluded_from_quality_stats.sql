-- Migration 067 — WS3/H5 (27 May remaining work): "this conversation didn't
-- work" rating option. The rating row still exists (so the one-rating-per-
-- match dedup and the rejoin replay treat the match as handled) but it must
-- not drag down anyone's quality averages — a no-show partner or a tech
-- failure is not a 1-star conversation. Additive + reversible.
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS excluded_from_quality_stats BOOLEAN NOT NULL DEFAULT FALSE;
