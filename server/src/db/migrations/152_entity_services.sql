-- Entity services (Shirley pilot S7, 11 Nov 2026; brief RSN 15: "Put services on Entity, not on Person").
--
-- An entity lists the services it offers from a controlled list, each with an optional short description and an
-- optional website. People stay about people: nothing is added to users.
--   category     the shared ENTITY_SERVICE_CATEGORIES, written out (migration-152.test.ts fails if the two differ).
--                Removing one later is a new migration that maps the rows first, then narrows this CHECK.
--   description  at most 280 characters (VARCHAR counts characters, as the route does); blank is stored as NULL.
--   website      an https address only (the route also refuses javascript:, credentials and hosts without a dot).
--   position     the order the entity's admins chose.
-- One row per category per entity. An entity is archived, never deleted; ON DELETE CASCADE only matters if one is
-- ever deleted for good. Whoever added a row may close their account: created_by then becomes NULL.
--
-- Only adds: one new table and its indexes, each made only when missing. Safe to run twice.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS entity_services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  category    VARCHAR(40) NOT NULL CHECK (category IN ('advisory', 'coaching', 'consulting', 'design', 'development',
                                                      'education_training', 'events', 'finance', 'funding',
                                                      'hiring_recruitment', 'legal', 'marketing', 'mentoring',
                                                      'research', 'other')),
  description VARCHAR(280) NULL CHECK (description IS NULL OR length(btrim(description)) > 0),
  website     VARCHAR(500) NULL CHECK (website IS NULL OR website ~* '^https://[^[:space:]]+$'),
  position    SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_entity_services_category UNIQUE (entity_id, category)
);

-- An entity's own list is read through the unique index (entity_id leads it). This one serves a later "entities that
-- offer X" filter.
CREATE INDEX IF NOT EXISTS idx_entity_services_category ON entity_services (category);
-- Who added a row, for an account closure's SET NULL.
CREATE INDEX IF NOT EXISTS idx_entity_services_created_by ON entity_services (created_by) WHERE created_by IS NOT NULL;
