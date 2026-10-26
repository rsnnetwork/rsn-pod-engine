-- 116 — group chats started from an event (26 Oct 2026).
--
-- Stefan, 25 Oct (COM-04): "Can there be 3, 5, 10, 20, 50 people in a chat? There should be." An organiser
-- of a completed event starts a group chat with the people who took part in it, so a group learns a third
-- type, 'event', and remembers its event in session_id. When the event is deleted the link goes back to
-- null: the chat and its messages stay, as a conversation people already had.
--
-- 050 wrote dm_groups' two checks inline, so Postgres named them itself: dm_groups_type_check (the type
-- list: custom, pod) and dm_groups_check (a pod group needs a pod, a custom group has none). Both names were
-- read off the scratch database, built by the same 050, on 26 Oct 2026. They are replaced, by name, with:
--   dm_groups_type_check    custom, pod or event;
--   dm_groups_pod_id_check  a pod group needs its pod, any other group needs none.
-- Nothing makes an event group need session_id: deleting its event sets it to null, which such a check
-- would refuse, and the event could no longer be deleted.
--
-- Idempotent: the column and the index are added only if missing, and each named check is dropped (if it is
-- there) just before it is added again, so a second run ends in the same state. The guard at the end of the
-- block stops the migration if dm_groups still has a check under a name nobody expected, rather than leave
-- the old type list in force and every new event group failing on insert.
-- Additive: no row is touched (every existing group is custom or pod and passes both new checks), and
-- nothing is dropped but the two checks being replaced. notifications_type_check is not touched: 108
-- already allows group_message and is the only file of this batch that restates it.
-- No BEGIN/COMMIT: the runner wraps each file in its own transaction.

ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE dm_groups DROP CONSTRAINT IF EXISTS dm_groups_type_check;
  ALTER TABLE dm_groups DROP CONSTRAINT IF EXISTS dm_groups_check;
  ALTER TABLE dm_groups DROP CONSTRAINT IF EXISTS dm_groups_pod_id_check;

  ALTER TABLE dm_groups ADD CONSTRAINT dm_groups_type_check
    CHECK (type IN ('custom', 'pod', 'event'));
  ALTER TABLE dm_groups ADD CONSTRAINT dm_groups_pod_id_check
    CHECK (type <> 'pod' OR pod_id IS NOT NULL);

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'dm_groups'::regclass AND contype = 'c'
       AND conname NOT IN ('dm_groups_name_check', 'dm_groups_type_check', 'dm_groups_pod_id_check')
  ) THEN
    RAISE EXCEPTION 'migration 116: dm_groups has a check constraint it does not know; read it before applying';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dm_groups_session ON dm_groups (session_id) WHERE session_id IS NOT NULL;
