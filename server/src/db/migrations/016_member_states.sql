-- ─── Migration 016: Pod Member Status — Add declined + no_response ───────────
-- Adds two new member status values to reflect invite outcomes:
-- declined: invitee explicitly refused the invitation
-- no_response: invitee never responded to the invitation

ALTER TYPE pod_member_status ADD VALUE IF NOT EXISTS 'declined';
ALTER TYPE pod_member_status ADD VALUE IF NOT EXISTS 'no_response';
