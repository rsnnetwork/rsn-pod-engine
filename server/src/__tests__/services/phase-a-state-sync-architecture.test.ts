// Phase A — state-sync architecture (10 May review items 1, 2, 3, 4, 17).
//
// Pins the architectural invariants so the same bugs cannot regress:
//   1. DB is the single source of truth for matching eligibility.
//      `getEligibleParticipants` excludes `disconnected` users alongside
//      `removed/left/no_show`, so the matching engine no longer needs to
//      intersect with an in-memory presence map.
//   2. `handleHostGenerateMatches` and `handleHostRegenerateMatches` no
//      longer build `presentUserIds` from `presenceMap.keys()` and no
//      longer pass it to `generateSingleRound`. Pre-fix this caused ghost
//      users in matching whenever DB and presenceMap diverged.
//   3. `handleLeaveSession` always marks LEFT regardless of session phase.
//      Pre-fix, leaving during SCHEDULED/LOBBY_OPEN reset status to
//      REGISTERED — and REGISTERED was eligible for matching, so the user
//      was still paired even though they had clicked Leave.
//   4. `updateSessionStatus(COMPLETED|CANCELLED)` atomically nulls
//      `lobby_room_id` so an orphan LiveKit room id can never be queried
//      back into a completed event.
//   5. `completeSession` awaits `cleanupLiveKitRooms` before tearing down
//      in-memory state. Pre-fix this was fire-and-forget, so a failed
//      cleanup left LiveKit rooms alive after the in-memory entry was
//      already gone — exactly Stefan's #17 (lobby from May 7 still open).
//   6. The TTL reaper also calls `cleanupLiveKitRooms` before deleting
//      from `activeSessions`. A new orphan-lobby reaper sweeps any stale
//      `lobby_room_id` rows older than 1 h.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase A — single source of truth for live participant state', () => {
  describe('getEligibleParticipants excludes disconnected (DB is source of truth)', () => {
    const src = readSource('services/matching/matching.service.ts');

    it('both query branches exclude disconnected alongside removed/left/no_show', () => {
      // Find every status NOT IN clause inside getEligibleParticipants.
      const fnStart = src.indexOf('export async function getEligibleParticipants');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      const matches = fn.match(/sp\.status\s+NOT\s+IN\s*\([^)]+\)/gi) || [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
      for (const m of matches) {
        expect(m).toMatch(/'removed'/);
        expect(m).toMatch(/'left'/);
        expect(m).toMatch(/'no_show'/);
        expect(m).toMatch(/'disconnected'/);
      }
    });
  });

  describe('matching-flow.ts no longer intersects matching with presenceMap', () => {
    const src = readSource('services/orchestration/handlers/matching-flow.ts');

    it('handleHostGenerateMatches does not construct presentUserIds from presenceMap', () => {
      const fnStart = src.indexOf('export async function handleHostGenerateMatches');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // No `new Set(activeSession.presenceMap.keys())` — that was the source of
      // ghost-user bugs whenever DB status and presenceMap diverged.
      expect(fn).not.toMatch(/new Set\(\s*activeSession\.presenceMap\.keys\(\)/);
      // Eligibility check uses the DB-derived list.
      expect(fn).toMatch(/matchingService\.getEligibleParticipants\(/);
    });

    it('handleHostGenerateMatches calls generateSingleRound without a presence intersection', () => {
      const fnStart = src.indexOf('export async function handleHostGenerateMatches');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Either no presentUserIds positional arg at all, or an explicit
      // undefined placeholder. The forbidden form is passing a Set built
      // from presenceMap.
      expect(fn).not.toMatch(/generateSingleRound\([^)]*presenceMap/);
    });

    it('handleHostRegenerateMatches does not construct presentUserIds from presenceMap', () => {
      const fnStart = src.indexOf('export async function handleHostRegenerateMatches');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).not.toMatch(/new Set\(\s*activeSession\.presenceMap\.keys\(\)/);
      expect(fn).not.toMatch(/generateSingleRound\([^)]*presenceMap/);
    });
  });

  describe('handleLeaveSession always marks LEFT (no REGISTERED reset on early leave)', () => {
    const src = readSource('services/orchestration/handlers/participant-flow.ts');

    it('does not branch on SessionStatus.SCHEDULED or LOBBY_OPEN to keep status REGISTERED', () => {
      const fnStart = src.indexOf('export async function handleLeaveSession');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // The pre-fix code had a literal `=== SessionStatus.SCHEDULED` branch
      // that updated to REGISTERED. That branch must be gone.
      expect(fn).not.toMatch(/SessionStatus\.SCHEDULED[^}]+REGISTERED/);
      expect(fn).not.toMatch(/ParticipantStatus\.REGISTERED/);
      // And the unconditional LEFT update must be present.
      expect(fn).toMatch(/ParticipantStatus\.LEFT/);
    });
  });

  describe('updateSessionStatus auto-nulls lobby_room_id on COMPLETED/CANCELLED', () => {
    const src = readSource('services/session/session.service.ts');

    it('contains the auto-null branch keyed on COMPLETED or CANCELLED', () => {
      const fnStart = src.indexOf('export async function updateSessionStatus');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      // Branch matches the `else if (status === COMPLETED || status === CANCELLED)` form.
      expect(fn).toMatch(/SessionStatus\.COMPLETED[^}]*SessionStatus\.CANCELLED/);
      expect(fn).toMatch(/lobby_room_id\s*=\s*NULL/);
    });
  });

  describe('completeSession awaits cleanupLiveKitRooms before in-memory teardown', () => {
    const src = readSource('services/orchestration/handlers/round-lifecycle.ts');

    it('awaits cleanupLiveKitRooms instead of fire-and-forget', () => {
      const fnStart = src.indexOf('export async function completeSession');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Must AWAIT the cleanup; the old fire-and-forget form (`cleanupLiveKitRooms(sessionId).catch(...)` with no leading await) is not allowed.
      expect(fn).toMatch(/await\s+cleanupLiveKitRooms\(sessionId\)/);
    });

    it('cleanupLiveKitRooms call appears before activeSessions.delete in the teardown', () => {
      const fnStart = src.indexOf('export async function completeSession');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // The teardown is what this guards: rooms are closed before the event is
      // forgotten. Measure from the try block, because the guards ahead of it
      // may legitimately drop a stale in-memory entry for an event that is
      // already over, where there is no teardown to order against and no rooms
      // of ours to close (21 Sep 2026).
      const teardown = fn.slice(fn.indexOf('\n  try {'));
      const cleanupIdx = teardown.indexOf('cleanupLiveKitRooms(sessionId)');
      const deleteIdx = teardown.indexOf('activeSessions.delete(sessionId)');
      expect(cleanupIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(cleanupIdx).toBeLessThan(deleteIdx);
      // And nothing forgets the event before the teardown even begins.
      expect(fn.slice(0, fn.indexOf('\n  try {'))).not.toMatch(/cleanupLiveKitRooms/);
    });
  });

  describe('orchestration TTL reaper + new orphan-lobby reaper', () => {
    const src = readSource('services/orchestration/orchestration.service.ts');

    it('TTL reaper calls cleanupLiveKitRooms before activeSessions.delete', () => {
      // The 4-hour TTL block.
      const ttlBlockStart = src.indexOf('MAX_SESSION_AGE_MS');
      expect(ttlBlockStart).toBeGreaterThan(-1);
      // Grab a slice big enough to cover the setInterval body.
      const ttlBlock = src.slice(ttlBlockStart, ttlBlockStart + 2000);
      expect(ttlBlock).toMatch(/cleanupLiveKitRooms\(sessionId\)/);
      const cleanupIdx = ttlBlock.indexOf('cleanupLiveKitRooms(sessionId)');
      const deleteIdx = ttlBlock.indexOf('activeSessions.delete(sessionId)');
      expect(cleanupIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(cleanupIdx).toBeLessThan(deleteIdx);
    });

    it('orphan-lobby reaper exists, queries completed/cancelled sessions with non-null lobby_room_id', () => {
      // The new periodic block.
      expect(src).toMatch(/orphan-lobby reaper|Orphan-lobby reaper/);
      expect(src).toMatch(/status\s+IN\s*\(\s*'completed',\s*'cancelled'\s*\)/);
      expect(src).toMatch(/lobby_room_id\s+IS\s+NOT\s+NULL/);
      expect(src).toMatch(/UPDATE sessions SET lobby_room_id = NULL/);
    });
  });
});
