-- 032_pod_member_invites.sql
-- Allow pod directors to enable member-sent invitations

ALTER TABLE pods ADD COLUMN IF NOT EXISTS allow_member_invites BOOLEAN DEFAULT false;

COMMENT ON COLUMN pods.allow_member_invites IS 'When true, regular pod members can send invites (not just directors/hosts)';
