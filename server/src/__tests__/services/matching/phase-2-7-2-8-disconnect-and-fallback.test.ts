// ─── Phase 2.7 + 2.8 — Disconnect hardening + fallback ladder ──────────
//
// Pins the architectural changes shipped in 2.7 (auto-LEFT on confirmed
// disconnect via existing 15 s mid-match timer + 90 s stale-heartbeat path)
// and 2.8 (5-level fallback ladder per Spec §10).
//
// Phase 2.7 — both the 15 s disconnect timeout AND the stale-heartbeat
// detector now transition the user to LEFT and trigger
// maybeRepairFutureRounds when no reconnect happens. Per Ali's call on
// 6 May 2026: holding the user in DISCONNECTED state for 3 minutes
// (spec's literal interpretation) is bad UX — host sees stale presence
// and matching system pretends they're still there. 15 s decisive cut.
//
// Phase 2.8 — service layer iterates levels 0 → 4, stops at the first
// level producing a complete matching, tags pairs with the level reason.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 2.7 — Disconnect hardening (auto-LEFT at 15 s + stale-heartbeat)', () => {
  const src = readServer('services/orchestration/handlers/participant-flow.ts');

  describe('15 s mid-match disconnect timeout', () => {
    it('the 15-second timeout still exists at its original cadence', () => {
      // The reassignment-decision timer at 15 s is preserved — it fires the
      // partner-reassignment OR bye flow for the CURRENT round.
      expect(src).toMatch(/setTimeout\([\s\S]*?,\s*15000\)/);
    });

    it('after no-reconnect check, transitions user to LEFT via the chokepoint', () => {
      const fnStart = src.indexOf('export async function handleDisconnect(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // The auto-LEFT block sits inside the timeout body, after the
      // reconnect check, before reassignment. Pin: it calls
      // transitionParticipant with LEFT and triggers repair.
      expect(fn).toMatch(/transitionParticipant\([\s\S]+?ParticipantState\.LEFT/);
      expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*sessionId,\s*'left'\)/);
    });
  });

  describe('90 s stale-heartbeat detector', () => {
    it('stale-heartbeat path also transitions to LEFT + repairs future rounds', () => {
      const fnStart = src.indexOf('export function startHeartbeatStaleDetection(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/transitionParticipant\([\s\S]+?ParticipantState\.LEFT/);
      expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*sessionId,\s*'left'\)/);
    });

    it('STALE_HEARTBEAT_MS unchanged at 90s (network-blip tolerance)', () => {
      // 90 s is right for stable-connection users on flaky networks. The
      // 15 s mid-match path is for users who are in an active match and
      // need a faster decision because their partner is waiting.
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
