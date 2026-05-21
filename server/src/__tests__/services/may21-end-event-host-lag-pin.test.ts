// F4 (21 May Ali, evening test) — pin the End Event critical-path
// ordering so a future refactor can't silently re-introduce the host's
// 10-second stale UI after End Event.
//
// Symptom (live test, 21 May): host clicks End Event with 4 participants,
// host's screen sits on the old lobby/round UI for 10+ seconds before the
// recap appears. Participants transitioned faster.
//
// Root cause: the original ordering of completeSession was
//   1. updateSessionStatus            (≈30 ms)
//   2. ended_at update                (≈30 ms)
//   3. M1 participant sweep           (≈30 ms)
//   4. invite expiry                  (≈30 ms)
//   5. finalizeSessionEncounters      (N SERIAL INSERTs — bulk of the cost)
//   6. EMIT session:completed         ← only here did the client transition
//
// Fix: emit session:completed immediately after the two writes the
// client cares about (status + ended_at). Everything else moves to
// fire-and-forget after the emit. Encounter finalisation also gets
// parallelised internally (Promise.allSettled) so the background work
// itself clears in a few hundred ms instead of N × roundtrip.
//
// These pins assert the new ordering against the source so it can't
// silently revert.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('F4 (21 May Ali) — End Event host lag fix', () => {
  describe('completeSession emits BEFORE housekeeping', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
    const fnStart = src.indexOf('export async function completeSession');
    // completeSession runs ~80 lines; take a generous slice to make sure
    // we capture every step in the body (and the trailing finally).
    const body = src.slice(fnStart, fnStart + 8000);

    function locate(re: RegExp): number {
      const m = re.exec(body);
      return m ? m.index : -1;
    }

    it('emits session:completed before the M1 participant sweep', () => {
      const emitIdx = locate(/io\.to\(sessionRoom\(sessionId\)\)\.emit\('session:completed'/);
      const sweepIdx = locate(/UPDATE session_participants[\s\S]{0,400}left_at\s*=\s*COALESCE/);
      expect(emitIdx).toBeGreaterThan(-1);
      expect(sweepIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeLessThan(sweepIdx);
    });

    it('emits session:completed before invite expiry', () => {
      const emitIdx = locate(/io\.to\(sessionRoom\(sessionId\)\)\.emit\('session:completed'/);
      const inviteIdx = locate(/UPDATE invites SET status\s*=\s*'expired'/);
      expect(emitIdx).toBeGreaterThan(-1);
      expect(inviteIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeLessThan(inviteIdx);
    });

    it('emits session:completed before encounter finalisation', () => {
      const emitIdx = locate(/io\.to\(sessionRoom\(sessionId\)\)\.emit\('session:completed'/);
      const encIdx = locate(/ratingService\.finalizeSessionEncounters\(sessionId\)/);
      expect(emitIdx).toBeGreaterThan(-1);
      expect(encIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeLessThan(encIdx);
    });

    it('M1 sweep is fire-and-forget (NOT awaited)', () => {
      // The sweep must not be prefixed by `await` (or the host's UI
      // pays for it). It still .catch()es non-fatally.
      expect(body).toMatch(/\n\s*query\(\s*\n\s*`UPDATE session_participants/);
      // Negative match: there is no `await` immediately before the sweep.
      const sweepCtx = body.match(/[\s\S]{0,40}UPDATE session_participants/);
      expect(sweepCtx).toBeTruthy();
      expect(sweepCtx![0]).not.toMatch(/await\s+query\(\s*`UPDATE session_participants/);
    });

    it('invite expiry is fire-and-forget (NOT awaited)', () => {
      const ctx = body.match(/[\s\S]{0,40}UPDATE invites SET status/);
      expect(ctx).toBeTruthy();
      expect(ctx![0]).not.toMatch(/await\s+query\(\s*`UPDATE invites/);
    });

    it('encounter finalisation is fire-and-forget (NOT awaited)', () => {
      // ratingService.finalizeSessionEncounters(...) without a leading await
      const ctx = body.match(/[\s\S]{0,40}ratingService\.finalizeSessionEncounters\(sessionId\)/);
      expect(ctx).toBeTruthy();
      expect(ctx![0]).not.toMatch(/await\s+ratingService\.finalizeSessionEncounters/);
    });

    it('cleanupLiveKitRooms is STILL awaited (Phase A4 contract)', () => {
      // This MUST stay awaited so the room teardown completes before
      // activeSessions.delete in finally{}, else the lobby room
      // outlives the in-memory state and orphans on LiveKit.
      expect(body).toMatch(/await cleanupLiveKitRooms\(sessionId\)/);
    });

    it('M1 sweep semantics are unchanged (COALESCE + status filter intact)', () => {
      // Pin the actual sweep query shape — same intent as the original
      // M1 pin, just at the new location post-emit.
      expect(body).toMatch(/UPDATE session_participants[\s\S]{0,400}left_at\s*=\s*COALESCE\(\s*left_at\s*,\s*NOW\(\)/);
      expect(body).toMatch(/SET\s+status\s*=\s*'left'/);
      expect(body).toMatch(/status\s+NOT\s+IN\s*\(\s*'left'\s*,\s*'removed'\s*,\s*'no_show'\s*\)/);
      expect(body).toMatch(/M1 sweep \(21 May Ali\)/);
    });
  });

  describe('finalizeSessionEncounters runs INSERTs in parallel', () => {
    const src = readServer('services/rating/rating.service.ts');
    const fnStart = src.indexOf('export async function finalizeSessionEncounters');
    const fnEnd = src.indexOf('// ─', fnStart + 100);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);

    it('uses Promise.allSettled to parallelise the INSERT loop', () => {
      // Pre-fix: a `for (...) { await query(...) }` block. Now: a single
      // Promise.allSettled over a .map of queries. Either substring
      // alone is enough — both should be present.
      expect(body).toMatch(/Promise\.allSettled\(/);
      expect(body).toMatch(/matchesResult\.rows\.map\(/);
      // No inner `await` inside the map callback (would defeat the parallelism).
      expect(body).not.toMatch(/\.map\(\s*async[^{]*\{\s*await\b/);
    });

    it('still inserts into encounter_history with ON CONFLICT DO NOTHING (idempotent semantics preserved)', () => {
      expect(body).toMatch(/INSERT INTO encounter_history/);
      expect(body).toMatch(/ON CONFLICT \(user_a_id, user_b_id\) DO NOTHING/);
    });
  });
});
