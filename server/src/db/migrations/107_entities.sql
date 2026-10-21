-- server/src/db/migrations/107_entities.sql
-- Entities (21 Oct 2026). An Entity is an organisation people belong to or work with: a company, a fund,
-- a university (Strategic Foundation, "ENTITY"). Members create their own (client feedback, 19 Oct:
-- "Users should be able to create an Entity (their company) themselves") and link themselves to it with
-- a role. Entities are archived, never deleted, so every link survives an archive.
-- The kind and role lists are the shared lists ENTITY_KINDS and ENTITY_ROLES, written out;
-- migration-107.test.ts fails if the two ever differ. `about` is capped at 2000 characters by the routes.
-- Only adds: two new tables and their indexes.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL CHECK (length(btrim(name)) >= 2),
  kind        VARCHAR(40) NOT NULL CHECK (kind IN ('company', 'startup', 'fund', 'university', 'community',
                                                   'charity', 'project', 'investment_vehicle', 'association', 'other')),
  about       TEXT,
  location    VARCHAR(200),
  size        VARCHAR(40),
  website     VARCHAR(500),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Moves whenever the entity or its people change, so the most recently active entities can be listed.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

-- One active entity per name, whatever its case or outer spaces. Archiving one frees its name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_active_name
  ON entities (lower(btrim(name))) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_created_by ON entities (created_by);
-- The list with no search: the most recently active entities first.
CREATE INDEX IF NOT EXISTS idx_entities_active_recent
  ON entities (updated_at DESC) WHERE archived_at IS NULL;
-- The name search (ILIKE '%acme%'), with the trigram extension migration 088 installed for people search.
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON entities USING gin (name gin_trgm_ops) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS entity_members (
  entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(40) NOT NULL CHECK (role IN ('founder', 'employee', 'investor', 'advisor', 'board_member', 'partner',
                                                  'customer', 'member', 'former_employee', 'fan', 'follower', 'other')),
  title      VARCHAR(120),
  is_admin   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, user_id)
);

-- A member's own entities (their list, their profile). The primary key already serves an entity's people.
CREATE INDEX IF NOT EXISTS idx_entity_members_user ON entity_members (user_id);
