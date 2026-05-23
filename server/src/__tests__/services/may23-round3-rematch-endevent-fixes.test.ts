// 23 May (Stefan live test, 2nd run — Waseem host) follow-up fixes. Four
// issues surfaced after the first batch shipped:
//
//   #10 — Round-3 showed "Met 1x" repeats. Root cause: swapping an EARLIER
//         round leaves THIS round's pre-plan stale. handleHostGenerateMatches'
//         staleness check was eligibility-only (membership), so a Round-2 swap
//         (which doesn't change membership) slipped past and the stale,
//         now-repeating pre-plan was surfaced as-is. Fix: also regenerate when
//         a pre-planned pair now overlaps a prior round.
//
//   #5b — Re-match landed on the same arrangement and reported "no alternative"
//         even when other fresh arrangements existed (jitter too weak to
//         rotate). Fix: actively exclude the current arrangement's pairs to
//         FORCE a different one; only report no-alternative when the forced
//         attempt can't stay fresh.
//
//   #11 — End Event during an active round ended the ROUND, not the event
//         (host had to press 3×); and the host stayed stuck on the main-room
//         screen after the event ended (missed the session:completed emit;
//         only a refresh fixed it). Fix: an endRequested flag completes the
//         event after the current round's rating in one press, and
//         completeSession emits to each participant's stable userRoom +
//         the client self-heals to recap.
//
//   #6 — A participant pulled back early rated their partner, then got the
//        rating form AGAIN at round end. The dedup keyed on match_id, but a
//        pull-back/reassign files the rating under a different match id. Fix:
//        partner-keyed dedup (from_user_id + to_user_id, round-scoped).

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import { MatchingEngineV1 } from '../../services/matching/matching.engine';
import { pairKey } from '../../services/matching/matching.interface';
import { MatchingConfig, MatchingParticipant, MatchingWeights } from '@rsn/shared';

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

const flowSrc = () => readServer('services/orchestration/handlers/matching-flow.ts');
const serviceSrc = () => readServer('services/matching/matching.service.ts');
const lifecycleSrc = () => readServer('services/orchestration/handlers/round-lifecycle.ts');
const hostActionsSrc = () => readServer('services/orchestration/handlers/host-actions.ts');
const stateSrc = () => readServer('services/orchestration/state/session-state.ts');

function fnSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\nexport ', start + 1));
}

describe('23 May 2nd-test fixes — round-3 repeats, re-match rotation, end-event, double-rating', () => {
  // ── #5b — engine guard: rotation IS possible when the current arrangement
  // is excluded. Load-bearing for the handler fix; if the engine ever stops
  // honouring excludedPairs, #5b silently regresses to "no alternative".
  describe('#5b — engine can rotate to a different fresh arrangement', () => {
    const DEFAULT_WEIGHTS: MatchingWeights = {
      sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15,
      companyDiversity: 0.15, languageMatch: 0.10, encounterFreshness: 0.10,
    };
    const config: MatchingConfig = {
      weights: DEFAULT_WEIGHTS, hardConstraints: [], numberOfRounds: 5,
      avoidDuplicates: true, globalOptimize: false,
    };
    const mk = (id: string): MatchingParticipant => ({
      userId: id, interests: [], reasonsToConnect: [], industry: null,
      company: null, languages: ['english'], timezone: 'UTC', attributes: {},
    });
    const participants = [mk('A'), mk('B'), mk('C'), mk('D')];

    it('excluding the current arrangement yields a DIFFERENT, complete, fresh matching', () => {
      const engine = new MatchingEngineV1();
      const first = engine.generateRound(participants, config, new Set(), [], 1);
      const firstKeys = first.pairs.map(p => pairKey(p.participantAId, p.participantBId));
      const excludeCurrent = new Set<string>(firstKeys);

      const second = engine.generateRound(participants, config, excludeCurrent, [], 1, { regenerate: true });
      const secondKeys = second.pairs.map(p => pairKey(p.participantAId, p.participantBId));

      // Complete (4 people → 2 pairs, no bye)
      expect(second.pairs.length).toBe(2);
      expect(second.byeParticipants || []).toHaveLength(0);
      // Genuinely different
      expect([...secondKeys].sort().join('|')).not.toBe([...firstKeys].sort().join('|'));
      // Fresh — none of the excluded (current) pairs reused
      for (const k of secondKeys) expect(excludeCurrent.has(k)).toBe(false);
    });
  });

  // ── #10 — pre-plan repeat-awareness
  describe('#10 — surfacing a pre-plan regenerates when it now repeats a prior round', () => {
    it('handleHostGenerateMatches computes prior-round pair keys for the repeat check', () => {
      const fn = fnSlice(flowSrc(), 'export async function handleHostGenerateMatches');
      expect(fn).toMatch(/priorRoundPairKeys/);
    });

    it('the "surface pre-plan as-is" branch is gated on NOT repeating a prior round', () => {
      const fn = fnSlice(flowSrc(), 'export async function handleHostGenerateMatches');
      // sameMembers alone is no longer sufficient — a stale repeat must force regen.
      expect(fn).toMatch(/planRepeatsPriorRound/);
      expect(fn).toMatch(/sameMembers\s*&&\s*!planRepeatsPriorRound/);
    });

    it('exposes a priorRoundPairKeys helper mirroring the engine no-repeat query', () => {
      const src = flowSrc();
      expect(src).toMatch(/async function priorRoundPairKeys/);
      // Same filter the engine uses: other rounds, non-cancelled, non-manual.
      const helper = src.slice(src.indexOf('async function priorRoundPairKeys'));
      expect(helper).toMatch(/round_number != /);
      expect(helper).toMatch(/is_manual = FALSE/);
    });
  });

  // ── #5b — re-match actively rotates
  describe('#5b — Re-match forces a different fresh arrangement before giving up', () => {
    it('generateSingleRound accepts excludePairKeys and unions them into excludedPairs', () => {
      const src = serviceSrc();
      expect(src).toMatch(/excludePairKeys\?:\s*string\[\]/);
      expect(src).toMatch(/excludePairKeys[\s\S]{0,120}excludedPairs\.add\(k\)/);
    });

    it('handleHostRegenerateMatches retries with the current arrangement excluded', () => {
      const fn = fnSlice(flowSrc(), 'export async function handleHostRegenerateMatches');
      expect(fn).toMatch(/excludePairKeys/);
      // Freshness gate — only accept the forced retry if it doesn't repeat a prior round.
      expect(fn).toMatch(/priorRoundPairKeys/);
      // Still reports the genuine dead-end.
      expect(fn).toMatch(/REMATCH_NO_ALTERNATIVE/);
    });
  });

  // ── #11a — one-press End Event during an active round
  describe('#11a — End Event during a round ends the event after the rating window (one press)', () => {
    it('ActiveSession carries an endRequested flag', () => {
      expect(stateSrc()).toMatch(/endRequested\?:\s*boolean/);
    });

    it('handleHostEnd sets endRequested when ending during an active round', () => {
      const fn = fnSlice(hostActionsSrc(), 'export async function handleHostEnd');
      expect(fn).toMatch(/endRequested\s*=\s*true/);
    });

    it('endRatingWindow completes the event when endRequested is set', () => {
      const fn = fnSlice(lifecycleSrc(), 'export async function endRatingWindow');
      expect(fn).toMatch(/endRequested/);
      expect(fn).toMatch(/completeSession\(io,\s*sessionId\)/);
    });
  });

  // ── #11b — host self-heals to recap even if the socket missed completion
  describe('#11b — completion reaches every participant + client self-heal', () => {
    it('completeSession emits session:completed to each participant userRoom (not just sessionRoom)', () => {
      const fn = fnSlice(lifecycleSrc(), 'export async function completeSession');
      expect(fn).toMatch(/userRoom\(/);
      // The per-user emit must carry the completed signal.
      expect(fn).toMatch(/userRoom\([\s\S]{0,40}\)\.emit\('session:completed'/);
    });

    it('LiveSessionPage polls session status and transitions to recap on completed', () => {
      const src = readClient('features/live/LiveSessionPage.tsx');
      expect(src).toMatch(/COMPLETION_SELF_HEAL/);
    });
  });

  // ── #6 — partner-keyed rating dedup
  describe('#6 — no double rating form after an early pull-back/reassign', () => {
    it('endRound dedup keys on the partner (to_user_id), round-scoped, not a single match_id', () => {
      const fn = fnSlice(lifecycleSrc(), 'export async function endRound');
      // The already-rated lookup must survive a match-id change (reassign):
      // scope by round + check the specific partner, not just match_id.
      expect(fn).toMatch(/to_user_id/);
      expect(fn).toMatch(/round_number/);
    });
  });

  // ── #13 — round start must not false-no-show present-but-stale participants
  describe('#13 — detectNoShows reconciles presence against live sockets', () => {
    it('checks live sockets in the session room before marking no-show', () => {
      const fn = fnSlice(lifecycleSrc(), 'export async function detectNoShows');
      // Heartbeat presenceMap alone goes stale during a long preview/swap setup;
      // a no-show must consider live socket membership too, or the final round
      // auto-ends and the event jumps to "all rounds completed".
      expect(fn).toMatch(/fetchSockets\(\)/);
      expect(fn).toMatch(/liveSocketUserIds/);
      expect(fn).toMatch(/isPresent\(/);
    });
  });
});
