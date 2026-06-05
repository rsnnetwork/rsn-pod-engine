// ─── Phase 2.7 + 2.8 — Disconnect handling + fallback ladder ──────────
//
// Original Phase 2.7 design (6 May 2026 spec) auto-transitioned users
// to LEFT after a 15 s mid-match disconnect or a 90 s stale heartbeat,
// and triggered maybeRepairFutureRounds on the assumption that "host
// shouldn't see stale presence." That design was reverted on 21 May
// after Ali's live test showed the trust-killer mismatch: 8 actual
// participants in the room, UI showing 5 because three of them had
// 16-second network blips and got permanently marked LEFT. This file
// now pins the REVISED contract:
//
//   1. The 15 s disconnect timeout still fires — it still cleans up the
//      match (terminal status) — but it does NOT transition the
//      disconnected user to LEFT, and it does NOT call
//      maybeRepairFutureRounds('left'). The user stays in a non-terminal
//      session_participants status so every roster keeps showing them.
//      WS2 (27 May remaining work, 4 Jun) — the timeout body moved into the
//      shared scheduleMatchEndGrace helper (also used by Leave Event), and
//      the auto-reassign-or-bye ladder was REMOVED: a room dropping below 2
//      now ENDS for the survivor (rating → main). Anchors re-pointed; the
//      no-auto-LEFT assertions are unchanged in meaning.
//   2. The 90 s stale-heartbeat path clears presence but does NOT
//      transition the user to LEFT either. Same reasoning.
//   3. LEFT is set ONLY by: explicit session:leave handler (Phase A1),
//      host kick → REMOVED, or the event-end sweep in completeSession.
//
// Phase 2.8 — service layer iterates levels 0 → 4, stops at the first
// level producing a complete matching, tags pairs with the level reason.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 2.7 — Disconnect handling (M1 21 May fix: no auto-LEFT)', () => {
  const src = readServer('services/orchestration/handlers/participant-flow.ts');

  describe('15 s mid-match disconnect timeout', () => {
    it('the 15-second timeout still exists at its original cadence', () => {
      // The reassignment-decision timer at 15 s is preserved — it still
      // fires the partner-reassignment OR bye flow for the CURRENT round.
      // The change is what it does AFTER deciding the user didn't reconnect.
      expect(src).toMatch(/setTimeout\([\s\S]*?,\s*15000\)/);
    });

    it('the M1-fix comment block is present in the disconnect flow (handler + shared grace)', () => {
      // WS2 — the timeout body lives in scheduleMatchEndGrace; both the
      // handler (scheduling site) and the grace body carry the M1 marker.
      const fnStart = src.indexOf('export async function handleDisconnect(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/M1 fix \(21 May Ali\)/);
      const graceStart = src.indexOf('function scheduleMatchEndGrace(');
      expect(graceStart).toBeGreaterThan(-1);
      const grace = src.slice(graceStart, src.indexOf('\nexport ', graceStart + 1));
      expect(grace).toMatch(/M1 fix \(21 May Ali\)/);
    });

    it('the grace-expiry body does NOT transition the user to LEFT', () => {
      const graceStart = src.indexOf('function scheduleMatchEndGrace(');
      const grace = src.slice(graceStart, src.indexOf('\nexport ', graceStart + 1));
      expect(grace).not.toMatch(/transitionParticipant\([^)]*ParticipantState\.LEFT/);
      // The disconnect handler itself stays LEFT-free too.
      const fnStart = src.indexOf('export async function handleDisconnect(');
      const fn = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));
      expect(fn).not.toMatch(/transitionParticipant\([^)]*ParticipantState\.LEFT/);
    });

    it('the grace-expiry body does NOT trigger maybeRepairFutureRounds(left)', () => {
      const graceStart = src.indexOf('function scheduleMatchEndGrace(');
      const grace = src.slice(graceStart, src.indexOf('\nexport ', graceStart + 1));
      expect(grace).not.toMatch(/maybeRepairFutureRounds\(io,\s*sessionId,\s*'left'\)/);
    });

    it('the match-ending logic still runs at expiry (terminal status via trio-aware demote, NO re-pairing)', () => {
      // WS2 — the reassign ladder is gone: the room ends for the survivor.
      const graceStart = src.indexOf('function scheduleMatchEndGrace(');
      const grace = src.slice(graceStart, src.indexOf('\nexport ', graceStart + 1));
      // Terminal-status decision is preserved (now feeds the demote arg).
      expect(grace).toMatch(/Determine terminal status based on actual conversation state/);
      expect(grace).toMatch(/demoteParticipantFromMatch/);
      // No re-pair, no bye: the survivor's room ends instead.
      expect(grace).not.toMatch(/INSERT INTO matches/);
      expect(grace).not.toMatch(/match:bye_round/);
      expect(grace).toMatch(/endRoomEarlyForSurvivors/);
    });
  });

  describe('90 s stale-heartbeat detector', () => {
    it('stale-heartbeat path clears presence but does NOT mark user LEFT', () => {
      const fnStart = src.indexOf('export function startHeartbeatStaleDetection(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Still clears presence (so partner-side disconnect logic can react).
      expect(fn).toMatch(/setPresence\(sessionId,\s*userId,\s*null\)/);
      // No LEFT transition.
      expect(fn).not.toMatch(/transitionParticipant\([^)]*ParticipantState\.LEFT/);
      // No plan-repair with 'left' reason.
      expect(fn).not.toMatch(/maybeRepairFutureRounds\(io,\s*sessionId,\s*'left'\)/);
      // The M1 fix comment is present.
      expect(fn).toMatch(/M1 fix \(21 May Ali\)/);
    });

    it('participant:left socket emit still fires (visual "disconnected" treatment)', () => {
      // The roster still notifies viewers that the user's presence dropped —
      // the DB just doesn't get a terminal status stamped on the row.
      const fnStart = src.indexOf('export function startHeartbeatStaleDetection(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/emit\(\s*['"]participant:left['"]/);
    });

    it('STALE_HEARTBEAT_MS unchanged at 90s (network-blip tolerance)', () => {
      // 90 s is right for stable-connection users on flaky networks.
      expect(src).toMatch(/STALE_HEARTBEAT_MS\s*=\s*90_000/);
    });
  });
});

describe('Phase 2.8 — Fallback ladder (Spec §10)', () => {
  const src = readServer('services/matching/matching.service.ts');

  it('generateSingleRound iterates levels 0 → 4', () => {
    expect(src).toMatch(/for\s*\(\s*let\s+level\s*=\s*0\s*;\s*level\s*<=\s*4/);
  });

  it('L0 = strict (full encounterFreshness penalty, full excludedPairs)', () => {
    // The freshnessScale ternary handles this: level >= 2 ? 0 : level >= 1 ? 0.5 : 1.
    expect(src).toMatch(/freshnessScale\s*=\s*level\s*>=\s*2\s*\?\s*0[\s\S]*?level\s*>=\s*1\s*\?\s*0\.5[\s\S]*?:\s*1/);
  });

  it('L4 drops the within-event excludedPairs entirely', () => {
    expect(src).toMatch(/level\s*>=\s*4\s*\?\s*new\s+Set<string>\(\)/);
  });

  it('L3 relaxes half of excludedPairs (deterministic alphabetical-keyed)', () => {
    expect(src).toMatch(/halfExcludedPairs/);
    expect(src).toMatch(/sortedExcludedKeys\.slice\(Math\.floor\(sortedExcludedKeys\.length\s*\/\s*2\)\)/);
  });

  it('iteration stops at first level that produces complete matching', () => {
    expect(src).toMatch(/if\s*\(\s*matchedIds\.size\s*>=\s*eligibleEvenCount\s*\)\s*break/);
  });

  it('pairs are tagged with the fallback level via match_reason', () => {
    expect(src).toMatch(/fallback_l1_freshness_softened/);
    expect(src).toMatch(/fallback_l2_freshness_neutral/);
    expect(src).toMatch(/fallback_l3_partial_event_repeats/);
    expect(src).toMatch(/fallback_l4_event_repeats/);
  });

  it('L0 (strict) leaves pairs without fallback_used flag', () => {
    // The tag-pairs block is gated on landedAtLevel > 0, so L0 results
    // ship clean (fallback_used = false from the engine).
    expect(src).toMatch(/if\s*\(\s*landedAtLevel\s*>\s*0\s*&&\s*round\s*\)/);
  });
});
