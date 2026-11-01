-- server/src/db/migrations/130_circle_entities.sql
-- Entities linked to circles (30 Oct review, 7.3: "An entity should be linkable to one or more Circles"; L23).
-- One row per circle and entity. The people who run the circle (and platform admins) link and unlink; the reads
-- skip an archived circle or entity, and both are archived rather than deleted, so a link outlives an archive.
-- Only adds: one new table and its index.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS circle_entities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id  UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (circle_id, entity_id)
);

-- An entity's circles. The unique pair, which starts with circle_id, already serves a circle's entities.
CREATE INDEX IF NOT EXISTS idx_circle_entities_entity ON circle_entities (entity_id);
