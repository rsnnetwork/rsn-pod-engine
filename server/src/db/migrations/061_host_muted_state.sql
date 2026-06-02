-- Migration 061: Authoritative host-muted state (12 May 2026 review item 7)
--
-- Stefan #7: audio/mute logic still broken in production — admins couldn't
-- mute, participants couldn't unmute themselves once muted, Shradha was
-- stuck muted after a reconnect. Root cause is that mute today is a pure
-- LiveKit relay (lobby:mute_command socket emit, hostMuteCommand client
-- flag) with NO persistent server-side state. On reconnect, the new socket
-- has no idea the user was muted — the flag was held in the previous
-- session's memory only.
--
-- This migration adds a persistent host_muted flag on session_participants
-- so the server is the single authoritative source. Snapshot exposes it;
-- client respects it on cold-start and reconnect; future LiveKit permission
-- integration can revoke canPublishAudio when host_muted=TRUE.
--
-- Additive — column defaults to FALSE, existing rows untouched. Safe on a
-- live DB.

BEGIN;

ALTER TABLE session_participants
  ADD COLUMN host_muted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN host_muted_at TIMESTAMPTZ;

COMMENT ON COLUMN session_participants.host_muted IS
  'Phase O (12 May spec item 7) — TRUE when the host has muted this '
  'participant. Persisted so the mute survives reconnects. Cleared on '
  'unmute by host. Self-unmute does not clear this flag.';

COMMENT ON COLUMN session_participants.host_muted_at IS
  'Wall-clock time of the most recent host-mute action (set when host_muted '
  'flips to TRUE; left as-is when flipping to FALSE for audit history).';

COMMIT;
