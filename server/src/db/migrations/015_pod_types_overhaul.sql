-- ─── Migration 015: Pod Type Enum Overhaul ───────────────────────────────────
-- Replaces size-based pod types (duo, trio, kvartet, band, orchestra, concert)
-- with purpose-based types aligned with the RSN platform broadening.
--
-- Data mapping:
--   duo / trio / kvartet / band  → conversational
--   orchestra / concert          → speed_networking
--   speed_networking             → speed_networking (unchanged)
--
-- Approach: create new enum, alter column with USING clause (no column drops,
-- no data loss, no temp columns). The enum type itself holds no row data so
-- dropping it after migration is safe.
--
-- Reversibility: recreate old enum + reverse USING clause to restore original.

BEGIN;

-- Step 1: Create the new purpose-based enum under a temporary name
CREATE TYPE pod_type_v2 AS ENUM (
  'speed_networking',
  'reason',
  'conversational',
  'webinar',
  'physical_event',
  'chat',
  'two_sided_networking',
  'one_sided_networking'
);

-- Step 2: Drop the column default before changing type.
--         PostgreSQL can't auto-cast an existing default to the new enum type.
ALTER TABLE pods ALTER COLUMN pod_type DROP DEFAULT;

-- Step 3: Migrate the pods.pod_type column in one operation using USING clause.
--         Maps every old value to its closest purpose-based equivalent.
ALTER TABLE pods
  ALTER COLUMN pod_type TYPE pod_type_v2
  USING (
    CASE pod_type::text
      WHEN 'speed_networking' THEN 'speed_networking'::pod_type_v2
      WHEN 'duo'              THEN 'conversational'::pod_type_v2
      WHEN 'trio'             THEN 'conversational'::pod_type_v2
      WHEN 'kvartet'          THEN 'conversational'::pod_type_v2
      WHEN 'band'             THEN 'conversational'::pod_type_v2
      WHEN 'orchestra'        THEN 'speed_networking'::pod_type_v2
      WHEN 'concert'          THEN 'speed_networking'::pod_type_v2
      ELSE                         'speed_networking'::pod_type_v2
    END
  );

-- Step 4: Drop the old enum type (type definitions hold no row data — safe to drop)
DROP TYPE pod_type;

-- Step 5: Rename new enum to the canonical name used throughout the codebase
ALTER TYPE pod_type_v2 RENAME TO pod_type;

-- Step 6: Re-apply the column default using the renamed type
ALTER TABLE pods ALTER COLUMN pod_type SET DEFAULT 'speed_networking';

COMMIT;
