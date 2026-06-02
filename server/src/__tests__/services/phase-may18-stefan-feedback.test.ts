// Stefan's 18 May test feedback — Ship #1 architectural fixes.
//
// Bug 1 — Host pin broadcasts globally (was per-viewer local only).
// Bug 2 — Event director ("supreme host") can act on platform admins.
// Bug 4 — Matching eligibility includes 'disconnected' users so a
//          transient socket drop doesn't drop them from matching.
// Bug 5 — "Met one time" counts THIS event's prior rounds (not lifetime
//          cross-event encounter_history).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}

describe('Stefan 18 May — Ship #1 architectural fixes', () => {
  describe('Bug 1 — Host pin broadcasts globally', () => {
    const stateSrc = readServer('services/orchestration/state/session-state.ts');
    const actionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
    const snapshotSrc = readServer('services/session/session-state-snapshot.service.ts');
    const orchestrationSrc = readServer('services/orchestration/orchestration.service.ts');
    const eventsSrc = readShared('types/events.ts');
    const lobbySrc = readClient('features/live/Lobby.tsx');
    const storeSrc = readClient('stores/sessionStore.ts');
    const socketSrc = readClient('hooks/useSessionSocket.ts');

    it('ActiveSession carries pinnedUserId; persistence serialises it', () => {
      expect(stateSrc).toMatch(/pinnedUserId\?:\s*string\s*\|\s*null/);
      // Persist-to-Redis includes the new field so the global pin survives
      // server restart within the Redis TTL.
      expect(stateSrc).toMatch(/pinnedUserId:\s*session\.pinnedUserId\s*\?\?\s*null/);
    });

    it('handleHostSetPin exists, verifies host, persists, and broadcasts', () => {
      const fnIdx = actionsSrc.indexOf('export async function handleHostSetPin');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = actionsSrc.slice(fnIdx, fnIdx + 3000);
      expect(fn).toMatch(/await\s+verifyHost\(socket,\s*data\.sessionId\)/);
      // Mutates the in-memory state.
      expect(fn).toMatch(/activeSession\.pinnedUserId\s*=\s*pinnedUserId/);
      // Persists so it survives restart.
      expect(fn).toMatch(/persistSessionState\(sessionId,\s*activeSession\)/);
      // Broadcasts to the WHOLE session room — every participant updates.
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]pin:changed['"]/);
    });

    it('orchestration wires host:set_pin via wrapHandler', () => {
      expect(orchestrationSrc).toMatch(/wrapHandler\(\s*['"]host:set_pin['"]\s*,\s*socket,\s*handleHostSetPin/);
    });

    it('shared event types declare host:set_pin and pin:changed', () => {
      expect(eventsSrc).toMatch(
        /'host:set_pin':[\s\S]{0,200}sessionId:\s*string;\s*pinnedUserId:\s*string\s*\|\s*null/,
      );
      expect(eventsSrc).toMatch(
        /'pin:changed':[\s\S]{0,200}sessionId:\s*string;\s*pinnedUserId:\s*string\s*\|\s*null/,
      );
    });

    it('snapshot interface + return value include pinnedUserId', () => {
      expect(snapshotSrc).toMatch(/pinnedUserId:\s*string\s*\|\s*null/);
      expect(snapshotSrc).toMatch(/pinnedUserId:\s*activeSession\?\.pinnedUserId\s*\?\?\s*null/);
    });

    it('client store carries serverPinnedUserId; hydration reads it from snapshot', () => {
      expect(storeSrc).toMatch(/serverPinnedUserId:\s*string\s*\|\s*null/);
      expect(storeSrc).toMatch(/setServerPinnedUserId:/);
      // applyFullState pulls pinnedUserId off the snapshot.
      expect(storeSrc).toMatch(
        /serverPinnedUserId:[\s\S]{0,80}snapshot[\s\S]{0,20}pinnedUserId[\s\S]{0,30}\?\?\s*null/,
      );
      // reset() clears it.
      expect(storeSrc).toMatch(/serverPinnedUserId:\s*null/);
    });

    it('client socket subscribes to pin:changed and writes to the store', () => {
      expect(socketSrc).toMatch(/'pin:changed'/);
      expect(socketSrc).toMatch(
        /socket\.on\(\s*'pin:changed'[\s\S]{0,300}setServerPinnedUserId/,
      );
    });

    it('Lobby resolves server pin to a LiveKit sid; effectivePinnedSid = server || local', () => {
      // The resolver maps userId → sid via cameraTracksSorted.
      expect(lobbySrc).toMatch(/serverPinnedUserId/);
      expect(lobbySrc).toMatch(
        /participant\.identity\s*===\s*serverPinnedUserId/,
      );
      expect(lobbySrc).toMatch(/effectivePinnedSid\s*=\s*serverPinnedSid\s*\?\?\s*pinnedSid/);
    });

    it('Lobby pin button routes to server when acting host, local otherwise', () => {
      const fnIdx = lobbySrc.indexOf('const setEffectivePin');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = lobbySrc.slice(fnIdx, fnIdx + 2000);
      // Acting host branch emits host:set_pin.
      expect(fn).toMatch(/if\s*\(isHost\s*&&\s*sessionId\)/);
      expect(fn).toMatch(/socket\?\.emit\(\s*'host:set_pin'/);
      // Participant branch falls back to local pinnedSid setter.
      expect(fn).toMatch(/setPinnedSid\(sid\)/);
    });

    it('Lobby pinned-mode renders against effectivePinnedSid (not just local pinnedSid)', () => {
      expect(lobbySrc).toMatch(/effectivePinnedSid\s*\?\s*cameraTracksSorted\.find/);
    });
  });

  describe('Bug 2 — Supreme host (event director) overrides admin guard', () => {
    const actionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
    const hccSrc = readClient('features/live/HostControlCenter.tsx');

    it('refuseIfAdminTarget takes sessionId and shortcircuits when caller is the director', () => {
      const fnIdx = actionsSrc.indexOf('async function refuseIfAdminTarget');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = actionsSrc.slice(fnIdx, fnIdx + 1800);
      // New signature includes sessionId.
      expect(fn).toMatch(
        /async function refuseIfAdminTarget\(\s*socket:\s*Socket,\s*sessionId:\s*string,\s*targetUserId:\s*string/,
      );
      // Reads the director from sessions.host_user_id.
      expect(fn).toMatch(/SELECT\s+host_user_id\s+FROM\s+sessions/);
      // Returns true (allow) when caller is the director.
      expect(fn).toMatch(/sessionRow\.rows\[0\]\?\.host_user_id\s*===\s*callerUserId[\s\S]{0,80}return\s+true/);
    });

    it('all three call sites pass sessionId so the director carve-out can fire', () => {
      // handleHostRemoveParticipant — kick path.
      expect(actionsSrc).toMatch(/refuseIfAdminTarget\(socket,\s*data\.sessionId,\s*data\.userId\)/);
      // handleAssignCohost + handleRemoveCohost — make/remove co-host paths.
      expect(actionsSrc.match(/refuseIfAdminTarget\(socket,\s*sessionId,\s*userId\)/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('HCC client gate disables admin actions only when viewer is NOT the director', () => {
      // targetIsAdmin now factors in currentUserId !== hostUserId — director
      // sees enabled buttons even on admin targets.
      expect(hccSrc).toMatch(
        /targetIsAdmin=\{[\s\S]{0,300}currentUserId\s*!==\s*hostUserId/,
      );
    });
  });

  describe('Bug 4 — Matching eligibility includes disconnected users', () => {
    const matchingSrc = readServer('services/matching/matching.service.ts');
    const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');

    it('generateSingleRound uses NOT IN (removed/left/no_show), not the narrow whitelist', () => {
      // Both branches (with and without excludeUserIds) should use the
      // broader filter so 'disconnected' users — who appear in the lobby
      // header count — also reach matching.
      const matches = matchingSrc.match(
        /sp\.status\s+NOT\s+IN\s*\(\s*'removed',\s*'left',\s*'no_show'\s*\)/g,
      );
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
      // Negative — no remaining narrow whitelist in generateSingleRound.
      const generateIdx = matchingSrc.indexOf('export async function generateSingleRound');
      expect(generateIdx).toBeGreaterThan(-1);
      const endIdx = matchingSrc.indexOf('\nexport ', generateIdx + 1);
      const generateBody = matchingSrc.slice(generateIdx, endIdx > -1 ? endIdx : matchingSrc.length);
      expect(generateBody).not.toMatch(
        /sp\.status\s+IN\s*\(\s*'in_lobby',\s*'checked_in',\s*'registered'\s*\)/,
      );
    });

    it('matching-flow bye list query uses the same broad filter', () => {
      // Pre-fix the bye-list and the matched-list used different filters,
      // so users in status='disconnected' silently vanished from BOTH lists
      // even though they were counted in the lobby header.
      const broadMatches = flowSrc.match(
        /WHERE\s+session_id\s*=\s*\$1\s+AND\s+status\s+NOT\s+IN\s*\(\s*'removed',\s*'left',\s*'no_show'\s*\)/g,
      );
      expect(broadMatches).not.toBeNull();
    });
  });

  describe('Bug 5 — "Met one time" badge is policy-aware', () => {
    const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');

    it('sendMatchPreview picks the badge source based on matchingPolicy (lifetime vs in-event)', () => {
      // Ali's 18 May clarification — the badge must respect the session's
      // matching policy. Three policies exist (Phase 4 resolver):
      //   platform_wide → lifetime encounter_history (strict-rule signal)
      //   within_event   → this event's prior rounds (default)
      //   none           → this event's prior rounds (badge still useful)
      // Pin both branches.
      const fnStart = flowSrc.indexOf('export async function sendMatchPreview');
      expect(fnStart).toBeGreaterThan(-1);
      const fn = flowSrc.slice(fnStart, fnStart + 5000);
      expect(fn).toMatch(/resolveMatchingPolicy/);
      // platform_wide branch reads lifetime encounter_history.
      expect(fn).toMatch(
        /previewPolicy\s*===\s*'platform_wide'[\s\S]{0,400}FROM\s+encounter_history/,
      );
      // within_event / none branch reads matches for THIS session, prior rounds.
      expect(fn).toMatch(
        /FROM\s+matches[\s\S]{0,300}session_id\s*=\s*\$1[\s\S]{0,200}round_number\s*<\s*\$2/,
      );
      // Cancelled matches don't count as a "meeting".
      expect(fn).toMatch(/status\s+NOT\s+IN\s*\(\s*'cancelled'\s*\)/);
      // Manual breakouts are independent — don't poison the badge.
      expect(fn).toMatch(/is_manual\s*=\s*FALSE/);
    });

    it('encounterMap is built via a pair-bumping helper that handles trios (3 pairs each)', () => {
      const fnIdx = flowSrc.indexOf('export async function sendMatchPreview');
      // Bug 5 (18 May Ali) — body grew with the platform_wide branch;
      // widen the slice so the trio-bumping helper inside the within_event
      // branch is still in range.
      const fn = flowSrc.slice(fnIdx, fnIdx + 6500);
      // The bump() helper handles trios by adding all three pair edges.
      expect(fn).toMatch(/bump\(e\.participant_a_id,\s*e\.participant_b_id\)/);
      expect(fn).toMatch(/if\s*\(e\.participant_c_id\)/);
    });
  });
});
