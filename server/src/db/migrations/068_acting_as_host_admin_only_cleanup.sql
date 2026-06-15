-- SEC-1 (2026-06-13 audit C1) — neutralise poisoned acting_as_host opt-ins.
--
-- The acting-as-host self-toggle endpoint was formerly un-gated, so any
-- participant could POST { value: true } on their own session_participants
-- row and gain cohost powers via getEffectiveRole. The endpoint and the
-- role resolver are now gated to platform admins/super_admins; this clears
-- any TRUE override left on a non-admin user's row.
--
-- Opt-out (FALSE) rows are intentionally left untouched — they only
-- de-escalate, and a non-admin co-host may rely on one to attend as a
-- participant. Idempotent: a re-run matches zero rows.
--
-- No inner BEGIN/COMMIT: the migration runner (db/migrate.ts) already wraps
-- each file in its own transaction. (Until PLT-1 hardens the runner, an
-- inner COMMIT here would prematurely commit the runner's transaction.)
UPDATE session_participants sp
   SET acting_as_host = NULL
  FROM users u
 WHERE u.id = sp.user_id
   AND sp.acting_as_host = TRUE
   AND u.role NOT IN ('admin', 'super_admin');
