-- Migration 082: Seed email_config rows for the poke email loop (Task F2)
-- so admins can kill-switch poke request / acceptance emails from the
-- existing admin dashboard toggle (routes/admin.ts L542-576), the same as
-- every other email type. isEmailTypeEnabled() in email.service.ts fails
-- open if a row is missing, so this seed is what actually gives admins a
-- switch to flip, not a functional requirement.

BEGIN;

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('poke_request', TRUE, '{name} wants to meet you on RSN'),
  ('poke_accepted', TRUE, '{name} accepted your meeting request')
ON CONFLICT (email_type) DO NOTHING;

COMMIT;
