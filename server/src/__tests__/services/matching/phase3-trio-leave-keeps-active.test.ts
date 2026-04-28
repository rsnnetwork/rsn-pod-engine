// Phase 3 — Platform-spec spec, 29 April 2026.
//
// Bug from Stefan + the user's own description: when 1 user leaves a
// 3-person room (trio) — voluntarily OR via host-pull-back — the entire
// match used to be marked 'completed' immediately, killing the room for
// the OTHER 2 users. Per spec:
//
//   "if there is a trio room and one of the trio room participant leaves
//    the room and gets back to the main room, or the host fetch that
//    person back to the main room, of course these other two persons will
//    continue talking ... the one who just gets back to the main room
//    will rate and then get back to the main room"
//
// These tests pin the new architecture:
//   1. matching.service exports demoteParticipantFromMatch — single helper
//      that handles all three room sizes cleanly.
//   2. handleLeaveConversation calls the helper instead of issuing the
//      inline `UPDATE matches SET status='completed'` that nuked trios.
//   3. handleHostRemoveFromRoom calls the helper too, so host-pull-back
//      from a trio doesn't kill the room.
//   4. Both handlers branch on matchStillActive — the trio path emits a
//      lighter `match:participant_left` event (NOT partner_disconnected,
//      which implies the match has ended) and returns BEFORE the
//      single-partner solo-reassign / lobby flow runs.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../', rel),
    'utf8',
  );
}

describe('Phase 3 — trio leave keeps remaining users in active conversation', () => {
  describe('demoteParticipantFromMatch helper exists in matching.service', () => {
    const src = readServer('services/matching/matching.service.ts');

    it('exports demoteParticipantFromMatch', () => {
      expect(src).toMatch(/export async function demoteParticipantFromMatch/);
    });

    it('returns { remainingUserIds, matchStillActive }', () => {
      const fnStart = src.indexOf('export async function demoteParticipantFromMatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/remainingUserIds:\s*string\[\];\s*matchStillActive:\s*boolean/);
    });

    it('uses SELECT FOR UPDATE inside a transaction (concurrent-leave race safety)', () => {
      const fnStart = src.indexOf('export async function demoteParticipantFromMatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/return transaction\(/);
      expect(fn).toMatch(/FOR UPDATE/);
    });

    it('keeps match active when 2+ remain (trio with 1 leaver)', () => {
      const fnStart = src.indexOf('export async function demoteParticipantFromMatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // The 2+ branch: NULL out leaver's slot, keep match active.
      expect(fn).toMatch(/if\s*\(remaining\.length\s*>=\s*2\)/);
      expect(fn).toMatch(/matchStillActive:\s*true/);
      // The slots get re-canonicalised so the lowest UUID stays in slot A
      expect(fn).toMatch(/\[\.\.\.remaining\]\.sort/);
    });

    it('marks match terminal when 0 or 1 remain', () => {
      const fnStart = src.indexOf('export async function demoteParticipantFromMatch');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // The fallthrough sets status to terminalStatusIfRoomEmpties
      expect(fn).toMatch(/UPDATE matches SET status = \$2, ended_at = NOW\(\)/);
      expect(fn).toMatch(/matchStillActive:\s*false/);
    });
  });

  describe('handleLeaveConversation uses demoteParticipantFromMatch (trio-aware)', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');
    const fnStart = src.indexOf('export async function handleLeaveConversation');
    const fnEnd = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, fnEnd);

    it('calls demoteParticipantFromMatch instead of inline UPDATE', () => {
      expect(fn).toMatch(/matchingService\.demoteParticipantFromMatch/);
    });

    it('the legacy inline UPDATE matches SET status=completed is gone from the leave path', () => {
      // Pre-fix this killed the entire match on any leave, including trios.
      // The line could still appear elsewhere in the file (other handlers),
      // but the leaveConversation function body must not have it.
      expect(fn).not.toMatch(/UPDATE matches SET status = 'completed', ended_at = NOW\(\) WHERE id = \$1/);
    });

    it('trio branch emits match:participant_left (not match:partner_disconnected)', () => {
      // Find the matchStillActive branch
      const trioStart = fn.indexOf('if (matchStillActive)');
      expect(trioStart).toBeGreaterThan(-1);
      const trioEnd = fn.indexOf("return;", trioStart);
      const trioBody = fn.slice(trioStart, trioEnd);
      expect(trioBody).toMatch(/match:participant_left/);
      expect(trioBody).not.toMatch(/match:partner_disconnected/);
    });

    it('trio branch returns BEFORE the legacy clearRoomTimers / solo-reassign path', () => {
      const trioStart = fn.indexOf('if (matchStillActive)');
      const clearTimers = fn.indexOf('clearRoomTimers(userMatch.id)');
      expect(trioStart).toBeGreaterThan(-1);
      expect(clearTimers).toBeGreaterThan(trioStart);
      const trioReturn = fn.indexOf('return;', trioStart);
      expect(trioReturn).toBeGreaterThan(-1);
      expect(trioReturn).toBeLessThan(clearTimers);
    });
  });

  describe('handleHostRemoveFromRoom uses demoteParticipantFromMatch too (trio-aware)', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostRemoveFromRoom');
    const fnEnd = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, fnEnd);

    it('calls demoteParticipantFromMatch', () => {
      expect(fn).toMatch(/matchingService\.demoteParticipantFromMatch/);
    });

    it('trio branch emits match:participant_left (not partner_disconnected) and returns early', () => {
      const trioStart = fn.indexOf('if (removalDemote.matchStillActive)');
      expect(trioStart).toBeGreaterThan(-1);
      const returnIdx = fn.indexOf('return;', trioStart);
      const trioBody = fn.slice(trioStart, returnIdx);
      expect(trioBody).toMatch(/match:participant_left/);
      expect(trioBody).toMatch(/reason:\s*['"]host_removed['"]/);
    });

    it('trio branch refreshes the host dashboard before returning', () => {
      const trioStart = fn.indexOf('if (removalDemote.matchStillActive)');
      const returnIdx = fn.indexOf('return;', trioStart);
      const trioBody = fn.slice(trioStart, returnIdx);
      expect(trioBody).toMatch(/_emitHostDashboard\(data\.sessionId\)/);
    });
  });
});
