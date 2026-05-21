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
    const helper = readClient('lib/bgPreference.ts');
    const lobby = readClient('features/live/Lobby.tsx');
    const videoRoom = readClient('features/live/VideoRoom.tsx');

    it('shared bgPreference module exports save/load/apply', () => {
      expect(helper).toMatch(/export\s+function\s+saveBgPreference/);
      expect(helper).toMatch(/export\s+function\s+loadBgPreference/);
      expect(helper).toMatch(/export\s+async\s+function\s+applyBgPreference/);
      expect(helper).toMatch(/export\s+type\s+BgPreference/);
      // Uses sessionStorage (tab-scoped) and the documented key.
      expect(helper).toMatch(/sessionStorage/);
      expect(helper).toMatch(/rsn_bg_preference/);
    });

    it('Lobby saves preference on preset click', () => {
      // The picker onClick handler must persist after a successful apply
      // so the same choice flows into VideoRoom on the next breakout.
      expect(lobby).toMatch(/saveBgPreference\(\s*presetToPreference\(\s*preset\s*\)\s*\)/);
    });

    it('Lobby re-applies the saved preference whenever the camera is enabled', () => {
      // Issue 10 follow-up (21 May Stefan re-test) — the first fix used
      // a one-shot ref guard that flipped to "applied" the moment the
      // effect ran, BEFORE the camera track had published. The apply
      // call no-op'd silently and the guard locked us out from
      // retrying. The fix: drop the ref guard entirely; the dep array
      // now depends on `hookCamEnabled` so the apply re-fires the
      // instant the camera publishes (and every camera off→on toggle).
      expect(lobby).toMatch(/loadBgPreference\(\)/);
      expect(lobby).toMatch(/applyBgPreference\(\s*localParticipant\s*,\s*mod\s*,\s*pref\s*\)/);
      // The dep array must include hookCamEnabled — that's the reactive
      // signal that flips true when the local camera track is published.
      expect(lobby).toMatch(/\}, \[localParticipant, hookCamEnabled\]\);/);
      // The one-shot ref guard is GONE.
      expect(lobby).not.toMatch(/bgAutoAppliedRef/);
    });

    it('VideoRoom saves preference inside applyBackground', () => {
      expect(videoRoom).toMatch(/saveBgPreference\(\s*videoRoomToPreference\(\s*mode\s*,\s*imagePath\s*\)\s*\)/);
      // 'disabled' branch also saves so opting out persists.
      expect(videoRoom).toMatch(/saveBgPreference\(\s*\{\s*mode:\s*['"`]disabled['"`]\s*\}\s*\)/);
    });

    it('VideoRoom re-applies the saved preference whenever the camera is enabled', () => {
      // Same fix as Lobby — drop the one-shot ref, depend on
      // `hookCamEnabled` so the apply re-runs once the breakout's
      // camera track has actually published. This is the path that
      // failed Stefan's main↔breakout re-test on 21 May.
      expect(videoRoom).toMatch(/loadBgPreference\(\)/);
      expect(videoRoom).toMatch(/applyBgPreference\(\s*localParticipant\s*,\s*mod\s*,\s*pref\s*\)/);
      expect(videoRoom).toMatch(/isCameraEnabled:\s*hookCamEnabled/);
      expect(videoRoom).toMatch(/\}, \[localParticipant, hookCamEnabled\]\);/);
      expect(videoRoom).not.toMatch(/bgAutoAppliedRef/);
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
