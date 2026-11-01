-- server/src/db/migrations/129_entity_pictures_member_status.sql
-- An entity's logo and banner, and member claims that wait for its admins (30 Oct review, 7.1 and 7.2; L1, L23).
--
-- Pictures, as the member photo keeps them (migration 119): logo_blob / banner_blob are the pictures everyone sees
-- (cut on the server, with their type and the crop they were placed with); the *_source_* columns keep the picture
-- the admin chose, so it can be placed again later without choosing it again. pictures_updated_at goes into each
-- picture's address (?v=), so a new picture is never hidden behind a cached old one. Every entity today has none.
--
-- Member status: a claim is 'pending' until an entity admin approves it ('active'), declines it or removes the
-- member. The constant default makes every link that exists today 'active' (L23): nobody already listed disappears,
-- and every admin keeps their rights. A change of role or title an active member asks for waits in requested_role /
-- requested_title while their current link stays as it is; requested_at orders the admins' list.
--
-- Only adds: nullable columns, one NOT NULL column with a constant default (no rewrite), CHECKs guarded by name.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS logo_blob BYTEA;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS logo_mime VARCHAR(40);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS logo_crop JSONB;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS logo_source_blob BYTEA;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS logo_source_mime VARCHAR(40);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS banner_blob BYTEA;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS banner_mime VARCHAR(40);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS banner_crop JSONB;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS banner_source_blob BYTEA;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS banner_source_mime VARCHAR(40);
ALTER TABLE entities ADD COLUMN IF NOT EXISTS pictures_updated_at TIMESTAMPTZ;

ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_members_status_check') THEN
    ALTER TABLE entity_members ADD CONSTRAINT entity_members_status_check
      CHECK (status IN ('pending', 'active', 'declined', 'removed'));
  END IF;
END $$;

ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_role VARCHAR(40);
ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_title VARCHAR(120);
ALTER TABLE entity_members ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
-- The shared role list (ENTITY_ROLES), as migration 107 writes it for role; migration-129.test.ts compares the two.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_members_requested_role_check') THEN
    ALTER TABLE entity_members ADD CONSTRAINT entity_members_requested_role_check
      CHECK (requested_role IS NULL OR requested_role IN ('founder', 'employee', 'investor', 'advisor', 'board_member',
                                                          'partner', 'customer', 'member', 'former_employee', 'fan',
                                                          'follower', 'other'));
  END IF;
END $$;

-- The admins' Requests list: claims waiting, and changes waiting, oldest first.
CREATE INDEX IF NOT EXISTS idx_entity_members_requests
  ON entity_members (entity_id, requested_at) WHERE status = 'pending' OR requested_role IS NOT NULL;
