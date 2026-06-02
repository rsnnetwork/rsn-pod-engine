// May 20 RSN test doc — final batch: Issues 9, 10, 12, 13.
// Source-pattern assertions on the client + server changes that close
// the four outstanding items from the 20 May post-mortem. Acts as a
// regression pin so a future refactor can't silently reintroduce the
// bugs Stefan called out.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../', rel),
    'utf8',
  );
}

describe('May 20 doc — final batch (Issues 9, 10, 12, 13)', () => {
  // ─── Issue 9 — "Event ended on one account while still inside room" ──────
  describe('Issue 9 — LiveSessionPage clears LiveKit on session.status=completed', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');

    it('useEffect on session?.status flips LiveKit token AND match AND room AND phase', () => {
      // Find the effect that watches session?.status. Pre-fix the body
      // only did `setPhase('complete')`; the user kept broadcasting into
      // a defunct breakout. Now the body must touch the full teardown
      // surface (token, match, roomId, dashboard, byeRound, partner-
      // disconnected, leftCurrentRound) before flipping phase.
      const issueComment = src.indexOf('Issue 9');
      expect(issueComment).toBeGreaterThan(-1);
      const block = src.slice(issueComment, issueComment + 1800);
      expect(block).toMatch(/setLiveKitToken\(\s*null\s*,\s*null\s*\)/);
      expect(block).toMatch(/setMatch\(\s*null\s*\)/);
      expect(block).toMatch(/setRoomId\(\s*null\s*\)/);
      expect(block).toMatch(/setByeRound\(\s*false\s*\)/);
      expect(block).toMatch(/setPartnerDisconnected\(\s*false\s*\)/);
      expect(block).toMatch(/setLeftCurrentRound\(\s*false\s*\)/);
      expect(block).toMatch(/setMatchingOverlay\(\s*null\s*\)/);
      expect(block).toMatch(/setRoundDashboard\(\s*null\s*\)/);
      expect(block).toMatch(/setPhase\(\s*['"`]complete['"`]\s*\)/);
    });

    it('the effect early-returns if phase is already complete (idempotent)', () => {
      const issueComment = src.indexOf('Issue 9');
      const block = src.slice(issueComment, issueComment + 1800);
      expect(block).toMatch(/store\.phase\s*===\s*['"`]complete['"`]/);
    });
  });

  // ─── Issue 10 — "Background does not persist between main and breakout" ──
  describe('Issue 10 — Background preference persists across main↔breakout', () => {
    // The persistence REQUIREMENT is unchanged; the implementation was rebuilt
    // (27 May) into a shared hook + localStorage. These pins follow it there.
    const pref = readClient('lib/bgPreference.ts');
    const hook = readClient('hooks/useBackgroundEffects.ts');
    const lobby = readClient('features/live/Lobby.tsx');
    const videoRoom = readClient('features/live/VideoRoom.tsx');

    it('bgPreference persists to localStorage under the documented key', () => {
      expect(pref).toMatch(/export\s+function\s+saveBgPreference/);
      expect(pref).toMatch(/export\s+function\s+loadBgPreference/);
      expect(pref).toMatch(/export\s+type\s+BgPreference/);
      // localStorage so the choice also survives a refresh, not just a room hop.
      expect(pref).toMatch(/localStorage/);
      expect(pref).not.toMatch(/sessionStorage/);
      expect(pref).toMatch(/rsn_bg_preference/);
    });

    it('the shared hook re-applies the saved preference whenever the camera publishes', () => {
      // This is what makes the effect survive main→breakout→main: load the
      // persisted pref and re-apply it on the cameraReady signal; persist every
      // change; and destroy the processor on unmount so no worker leaks per hop.
      expect(hook).toMatch(/loadBgPreference\(\)/);
      expect(hook).toMatch(/saveBgPreference\(/);
      expect(hook).toMatch(/\}, \[localParticipant, cameraReady\]\);/);
      expect(hook).toMatch(/p\.destroy/);
    });

    it('both rooms drive background through the shared hook (no divergent copies)', () => {
      expect(lobby).toMatch(/useBackgroundEffects\(localParticipant, hookCamEnabled\)/);
      expect(videoRoom).toMatch(/useBackgroundEffects\(localParticipant, hookCamEnabled\)/);
      // picker persists by applying a preset → the hook saves it
      expect(lobby).toMatch(/bg\.apply\(presetToPreference\(preset\)\)/);
      // the old per-room inline apply + one-shot guard are gone
      expect(lobby).not.toMatch(/bgAutoAppliedRef/);
      expect(videoRoom).not.toMatch(/videoRoomToPreference/);
    });
  });

  // ─── Issue 13 — "Host should be able to unpin" ───────────────────────────
  describe('Issue 13 — Director can self-demote tile', () => {
    const lobby = readClient('features/live/Lobby.tsx');
    const handler = readServer('services/orchestration/handlers/host-actions.ts');

    it('server: handleHostSetTileSize no longer refuses director-self target', () => {
      // The pre-fix guard `targetUserId === activeSession.hostUserId →
      // INVALID_TARGET` is removed. Director self-demote is visual-only
      // and intentionally allowed.
      const idx = handler.indexOf('export async function handleHostSetTileSize');
      const block = handler.slice(idx, idx + 4000);
      expect(block).not.toMatch(/Director cannot demote their own tile/);
      expect(block).toMatch(/Issue 13/);
    });

    it('client: director sees a self-shrink/restore button on their own tile', () => {
      // Visible only when (isHost && isLocal && tileIsHost) — a non-
      // director acting host or a participant should not see it.
      expect(lobby).toMatch(/isHost\s*&&\s*isLocal\s*&&\s*tileIsHost/);
      expect(lobby).toMatch(/data-testid="tile-self-shrink-button"/);
      expect(lobby).toMatch(/data-testid="tile-self-restore-button"/);
    });

    it('client: the self-button reuses the same handleSetTileSize the cohost button calls', () => {
      // No new socket event — the existing host:set_tile_size flow now
      // permits a director→director target. The click handler binds to
      // the director's own identity so the server receives self-target.
      const idx = lobby.indexOf('data-testid="tile-self-shrink-button"');
      const block = lobby.slice(Math.max(0, idx - 600), idx + 200);
      expect(block).toMatch(/handleSetTileSize\(\s*trackRef\.participant\.identity\s*,\s*['"`]participant['"`]/);
    });
  });
});
