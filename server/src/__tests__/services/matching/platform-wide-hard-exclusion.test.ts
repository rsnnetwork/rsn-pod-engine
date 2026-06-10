// ─── Fix #1 — platform_wide must HARD-exclude prior meetings (service) ───
//
// Stefan's 25 May list, item #1: when matchingPolicy === 'platform_wide',
// two people who met in ANY prior event must NOT be paired (the UI promises
// "never matched again"). Pre-fix, cross-event history was loaded but only
// fed a soft score penalty (encounterFreshness weight 0.10), never a hard
// block.
//
// Post-fix: every pair from the loaded cross-event encounterHistory is added
// to the SAME hard-exclusion set used for within-event prior-round pairs, so
// the engine's candidate-build skip (`usedPairs.has(key) || hardExclusions
// .has(key)`) covers them. within_event and none behaviour stays unchanged.
//
// We assert behaviourally on the excludedPairs Set passed into the engine's
// generateRound at fallback level 0 (strict) — that is the set the engine
// uses to skip candidate pairs.

import { jest } from '@jest/globals';
import { pairKey } from '../../../services/matching/matching.interface';
import type { RoundAssignment } from '@rsn/shared';

const mockQuery = jest.fn<any>();
const mockTransaction = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery, transaction: mockTransaction }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionById = jest.fn<any>();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: any[]) => mockGetSessionById(...args),
}));

const mockGetBlockedPairs = jest.fn<any>();
jest.mock('../../../services/block/block.service', () => ({
  getBlockedPairsForUsers: (...args: any[]) => mockGetBlockedPairs(...args),
}));

// Capture the excludedPairs Set the service hands to the engine. The engine
// is invoked once per fallback level; we only need level 0 (strict).
let capturedExcludedByLevel: Set<string>[] = [];
const mockGenerateRound = jest.fn<any>();
jest.mock('../../../services/matching/matching.registry', () => ({
  getMatchingEngine: () => ({ generateRound: (...args: any[]) => mockGenerateRound(...args) }),
  DEFAULT_ENGINE_ID: 'speed_networking_v1',
}));

// A trivial complete-matching round so the fallback ladder stops at L0.
function completeRound(userIds: string[]): RoundAssignment {
  const pairs = [];
  for (let i = 0; i + 1 < userIds.length; i += 2) {
    pairs.push({
      participantAId: userIds[i], participantBId: userIds[i + 1],
      score: 0.5, reasonTags: [], matchReason: 'test',
      fallbackUsed: false, repeatInEvent: false, premiumInfluenced: false,
    });
  }
  return { roundNumber: 1, pairs, byeParticipant: null };
}

const PARTICIPANTS = ['u1', 'u2', 'u3', 'u4'];

function wireDbForGenerateSingleRound(opts: { matchingPolicy: string }) {
  mockGetSessionById.mockResolvedValue({
    id: 'sess-1',
    hostUserId: 'host',
    config: { numberOfRounds: 5, matchingPolicy: opts.matchingPolicy },
  });
  mockGetBlockedPairs.mockResolvedValue([]);
  mockTransaction.mockResolvedValue(undefined);

  // generateSingleRound issues queries in this order:
  //  1. participants (SELECT u.id ... FROM session_participants)
  //  2. encounter_history (only when policy === 'platform_wide')
  //  3. excludedPairs within-event (SELECT participant_a_id ... when policy !== 'none')
  //  4. inviter/invitee (SELECT inviter_id ...)
  //  5. pod template lookup (SELECT matching_template_id ...) — may or may not run
  //  6. match_requests (loadMatchRequestsForEvent)
  // We route by SQL content so order changes don't break the test.
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql);
    if (/FROM session_participants\s+JOIN users/i.test(s) || /JOIN users u ON u\.id = sp\.user_id/i.test(s)) {
      return Promise.resolve({
        rows: PARTICIPANTS.map(id => ({
          userId: id, interests: [], reasonsToConnect: [], industry: null,
          company: null, languages: ['english'], timezone: 'UTC',
          attributes: {}, isPremium: false,
        })),
      });
    }
    if (/FROM encounter_history/i.test(s)) {
      // u1 met u2, u3 AND u4 in PRIOR events. u1 having met everyone makes at
      // least one repeat mathematically FORCED in any matching — so the #6
      // repeat-minimization (reduceRepeatPairs) cannot drive usedRepeats to
      // false, which is exactly what the "ladder relaxed → surfaces a repeat"
      // test needs. (Pre-#6 this was just u1&u2; with only one excluded pair a
      // fully-fresh re-pairing existed, so the 2-opt correctly removed it.)
      const base = { timesMet: 2, lastMetAt: new Date(), mutualMeetAgain: false, averageRating: null };
      return Promise.resolve({
        rows: [
          { userAId: 'u1', userBId: 'u2', ...base },
          { userAId: 'u1', userBId: 'u3', ...base },
          { userAId: 'u1', userBId: 'u4', ...base },
        ],
      });
    }
    if (/FROM matches\b/i.test(s) && /round_number != /i.test(s)) {
      // No within-event prior rounds.
      return Promise.resolve({ rows: [] });
    }
    if (/FROM invites/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM match_requests/i.test(s)) return Promise.resolve({ rows: [] });
    if (/matching_template_id FROM pods/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM matching_templates/i.test(s)) return Promise.resolve({ rows: [] });
    // persistMatches DELETE/INSERT run inside transaction() mock; ignore.
    return Promise.resolve({ rows: [] });
  });

  capturedExcludedByLevel = [];
  mockGenerateRound.mockImplementation((_participants: any, _config: any, excludedPairs: Set<string>) => {
    capturedExcludedByLevel.push(new Set(excludedPairs));
    return completeRound(PARTICIPANTS);
  });
}

describe('Fix #1 — platform_wide hard-excludes prior-event pairs', () => {
  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
    mockGenerateRound.mockReset();
    mockGetSessionById.mockReset();
    mockGetBlockedPairs.mockReset();
    mockTransaction.mockReset();
  });

  it('adds cross-event encounter pairs to the engine excludedPairs set under platform_wide', async () => {
    wireDbForGenerateSingleRound({ matchingPolicy: 'platform_wide' });
    const { generateSingleRound } = await import('../../../services/matching/matching.service');
    await generateSingleRound('sess-1', 1, ['host']);

    expect(capturedExcludedByLevel.length).toBeGreaterThan(0);
    const level0Excluded = capturedExcludedByLevel[0];
    // The prior-event pair (u1,u2) must be hard-excluded at strict level.
    expect(level0Excluded.has(pairKey('u1', 'u2'))).toBe(true);
  });

  it('does NOT hard-exclude the cross-event pair under within_event', async () => {
    wireDbForGenerateSingleRound({ matchingPolicy: 'within_event' });
    const { generateSingleRound } = await import('../../../services/matching/matching.service');
    await generateSingleRound('sess-1', 1, ['host']);

    expect(capturedExcludedByLevel.length).toBeGreaterThan(0);
    const level0Excluded = capturedExcludedByLevel[0];
    // within_event loads NO cross-event history, so (u1,u2) is matchable.
    expect(level0Excluded.has(pairKey('u1', 'u2'))).toBe(false);
  });

  it('platform_wide cross-event exclusions are relaxed by the fallback ladder (not present at L4)', async () => {
    wireDbForGenerateSingleRound({ matchingPolicy: 'platform_wide' });
    // Force the ladder to keep climbing by returning an INCOMPLETE matching
    // at every level until the last — so we can inspect the L4 excluded set.
    mockGenerateRound.mockReset();
    capturedExcludedByLevel = [];
    mockGenerateRound.mockImplementation((_participants: any, _config: any, excludedPairs: Set<string>) => {
      capturedExcludedByLevel.push(new Set(excludedPairs));
      // Always incomplete (0 pairs) so the loop runs through all 5 levels.
      return { roundNumber: 1, pairs: [], byeParticipant: null } as RoundAssignment;
    });

    const { generateSingleRound } = await import('../../../services/matching/matching.service');
    await generateSingleRound('sess-1', 1, ['host']);

    // 5 levels (0..4) were attempted.
    expect(capturedExcludedByLevel.length).toBe(5);
    // L0 hard-excludes the cross-event pair…
    expect(capturedExcludedByLevel[0].has(pairKey('u1', 'u2'))).toBe(true);
    // …and L4 (full relaxation) drops it, so a forced repeat is allowed.
    expect(capturedExcludedByLevel[4].has(pairKey('u1', 'u2'))).toBe(false);
  });
});

describe('Fix #9 — generateSingleRound surfaces the fallback level reached', () => {
  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
    mockGenerateRound.mockReset();
    mockGetSessionById.mockReset();
    mockGetBlockedPairs.mockReset();
    mockTransaction.mockReset();
  });

  it('reports fallbackLevel 0 and no repeats when a complete fresh matching exists', async () => {
    wireDbForGenerateSingleRound({ matchingPolicy: 'within_event' });
    const { generateSingleRound } = await import('../../../services/matching/matching.service');
    const round = await generateSingleRound('sess-1', 1, ['host']);
    expect(round.fallbackLevel).toBe(0);
    expect(round.usedRepeats).toBe(false);
  });

  it('reports a non-zero fallbackLevel and usedRepeats=true when the ladder had to relax', async () => {
    wireDbForGenerateSingleRound({ matchingPolicy: 'platform_wide' });
    // Incomplete until L4 — forces the ladder to climb and surface a repeat.
    mockGenerateRound.mockReset();
    capturedExcludedByLevel = [];
    mockGenerateRound.mockImplementation((_p: any, _c: any, excludedPairs: Set<string>, _hist: any, roundNumber: number) => {
      capturedExcludedByLevel.push(new Set(excludedPairs));
      // Only the final level (excludedPairs empty = L4) produces a complete matching.
      if (excludedPairs.size === 0) return completeRound(PARTICIPANTS);
      return { roundNumber, pairs: [], byeParticipant: null } as RoundAssignment;
    });

    const { generateSingleRound } = await import('../../../services/matching/matching.service');
    const round = await generateSingleRound('sess-1', 1, ['host']);
    expect(round.fallbackLevel).toBe(4);
    expect(round.usedRepeats).toBe(true);
  });
});
