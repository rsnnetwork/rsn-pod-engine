// ─── Seating a round's basket (10 Nov 2026 spec, Part 2 Task 8; 12/08, section 07 locks) ────────────────────
//
// redistributeRound seats the people waiting in a round's basket without reading or writing a locked meeting and
// without moving anyone already seated: rooms holding one person first, then the engine (Task 7's
// generateGroupedRound, the real one) pairs the rest into new rooms, then a single leftover joins a pair as a
// trio only when the one room checker allows the three. Whoever still waits says why.

jest.mock('../../../db', () => ({ __esModule: true, query: jest.fn(), transaction: jest.fn() }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/session/session.service', () => ({ __esModule: true, getSessionById: jest.fn() }));
jest.mock('../../../services/session/event-groups.service', () => ({
  __esModule: true, getEventGroupRules: jest.fn(), groupsForParticipants: jest.fn(),
}));

import {
  GROUP_PRESETS, checkRoom,
  type EventGroupRules, type MatchingConfig, type MatchingParticipant, type RoomCheckContext, type RoundAssignment,
} from '@rsn/shared';
import { pairKey } from '../../../services/matching/matching.interface';
import { generateGroupedRound } from '../../../services/matching/matching.service';
import { redistributeRound, type RedistributeInput } from '../../../services/schedule/redistribute';

function ctxOf(opts: {
  round?: number; rules?: EventGroupRules | null; groups?: Record<string, string[]>; blocked?: string[][]; met?: string[][];
} = {}): RoomCheckContext {
  const blocked = new Set((opts.blocked ?? []).map(([a, b]) => pairKey(a, b)));
  const met = new Set((opts.met ?? []).map(([a, b]) => pairKey(a, b)));
  return {
    round: opts.round ?? 1,
    rules: opts.rules ?? null,
    groupsOf: (id) => opts.groups?.[id] ?? [],
    hardExcluded: (a, b) => blocked.has(pairKey(a, b)),
    metBefore: (a, b) => met.has(pairKey(a, b)),
    maxRoomSize: 3,
  };
}

const person = (userId: string): MatchingParticipant => ({
  userId, interests: [], reasonsToConnect: [], industry: null, company: null, languages: ['english'], timezone: 'UTC', attributes: {},
});

/** The real engine for one round of an event, as the board's generator drives it. */
function engineFor(ctx: RoomCheckContext, groups: Record<string, string[]> = {}): (people: string[]) => RoundAssignment {
  return (people) => {
    const config: MatchingConfig = {
      weights: {
        sharedInterests: 0.25, sharedReasons: 0.25, industryDiversity: 0.15, companyDiversity: 0.15, languageMatch: 0.1,
        encounterFreshness: 0.1,
      },
      hardConstraints: [],
      numberOfRounds: 5,
      avoidDuplicates: true,
      globalOptimize: false,
      ...(ctx.rules && { groupRules: { rules: ctx.rules, groupsByUser: groups } }),
    };
    return generateGroupedRound({ participants: people.map(person), config, excludedPairs: new Set(), encounterHistory: [], round: ctx.round });
  };
}

const noEngine = () => jest.fn((): RoundAssignment => ({ roundNumber: 1, pairs: [], byeParticipant: null }));

function run(input: Partial<RedistributeInput> & Pick<RedistributeInput, 'seated' | 'basket' | 'ctx'>) {
  return redistributeRound({
    round: input.ctx.round, lockedRooms: new Set(), lockedSlots: new Set(), generate: noEngine(), ...input,
  });
}

const CROSS_ALL: EventGroupRules['rounds'] = [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }];
const foundersFunders = (fallback: EventGroupRules['fallback']): EventGroupRules => ({ ...GROUP_PRESETS.founders_funders, fallback, rounds: CROSS_ALL });
const FF_GROUPS = { f1: ['founder'], f2: ['founder'], f3: ['founder'], u1: ['funder'], u2: ['funder'] };

describe('redistributeRound (12/08)', () => {
  it('A, unassigned and redistributed, lands in a valid open seat and never in a locked meeting', () => {
    // Room 1 lost A and holds B; room 2 is locked with one person (an open seat, but locked); room 3 is full-ish.
    const seated = new Map([[1, ['b']], [2, ['e']], [3, ['c', 'd']]]);
    const out = run({ seated, basket: ['a'], lockedRooms: new Set([2]), ctx: ctxOf({ met: [['a', 'b']] }) });
    expect(out.seated.get(1)).toEqual(['b', 'a']);
    expect(out.seated.get(2)).toEqual(['e']);
    expect(out.placed).toEqual(['a']);
    expect(out.waiting).toEqual([]);
    expect(seated.get(1)).toEqual(['b']);

    // B blocked A: the open seat is not valid for A. A joins the unlocked pair as a trio, still never the locked room.
    const blocked = run({ seated, basket: ['a'], lockedRooms: new Set([2]), ctx: ctxOf({ blocked: [['a', 'b']] }) });
    expect(blocked.seated.get(1)).toEqual(['b']);
    expect(blocked.seated.get(2)).toEqual(['e']);
    expect(blocked.seated.get(3)).toEqual(['c', 'd', 'a']);
    for (const [room, members] of blocked.seated) expect({ room, ok: checkRoom(ctxOf({ blocked: [['a', 'b']] }), members).ok }).toEqual({ room, ok: true });
  });

  it('a single leftover kept from someone in every pair waits with no_allowed_partner, and nothing seated moves', () => {
    const seated = new Map([[1, ['a', 'b']], [2, ['c', 'd']]]);
    const generate = noEngine();
    const out = run({ seated, basket: ['l'], generate, ctx: ctxOf({ blocked: [['l', 'a'], ['l', 'd']] }) });
    expect(out.waiting).toEqual([{ userId: 'l', reason: 'no_allowed_partner' }]);
    expect(out.placed).toEqual([]);
    expect([...out.seated]).toEqual([[1, ['a', 'b']], [2, ['c', 'd']]]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('cross-group with 3 founders and 2 funders: two meetings, and the third founder waits for the group rule', () => {
    const ctx = ctxOf({ rules: foundersFunders('leave_unmatched'), groups: FF_GROUPS });
    const out = run({ seated: new Map(), basket: ['f1', 'f2', 'f3', 'u1', 'u2'], ctx, generate: engineFor(ctx, FF_GROUPS) });
    const rooms = [...out.seated.values()];
    expect(rooms).toHaveLength(2);
    for (const members of rooms) {
      expect(members).toHaveLength(2);
      expect(members.filter((id) => id.startsWith('f'))).toHaveLength(1);
      expect(checkRoom(ctx, members).ok).toBe(true);
    }
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0]).toMatchObject({ reason: 'group_rule' });
    expect(out.waiting[0].userId).toMatch(/^f/);
  });

  it('cross-group when the organiser lets people a rule leaves out meet their own group: the third founder is seated', () => {
    const ctx = ctxOf({ rules: foundersFunders('same_group_meeting'), groups: FF_GROUPS });
    const out = run({ seated: new Map(), basket: ['f1', 'f2', 'f3', 'u1', 'u2'], ctx, generate: engineFor(ctx, FF_GROUPS) });
    expect(out.waiting).toEqual([]);
    expect(out.placed.sort()).toEqual(['f1', 'f2', 'f3', 'u1', 'u2']);
    const rooms = [...out.seated.values()];
    expect(rooms).toHaveLength(2);
    for (const members of rooms) {
      const verdict = checkRoom(ctx, members, { fallback: true });
      expect(verdict.ok).toBe(true);
      expect(members.some((id) => id.startsWith('u'))).toBe(true);
    }
    const trio = rooms.find((m) => m.length === 3)!;
    expect(checkRoom(ctx, trio, { fallback: true }).warnings.map((w) => w.kind)).toContain('same_group_fallback');
  });

  it('the engine pairs the rest into new rooms numbered after the highest in use, and a locked meeting is never read', () => {
    const ctx = ctxOf();
    const seated = new Map([[7, ['x', 'y']]]);
    const generate = jest.fn(engineFor(ctx));
    const out = run({ seated, basket: ['a', 'b', 'c', 'd'], lockedRooms: new Set([7]), ctx, generate });
    expect(generate).toHaveBeenCalledWith(['a', 'b', 'c', 'd']);
    expect([...out.seated.keys()].sort((a, b) => a - b)).toEqual([7, 8, 9]);
    expect(out.seated.get(7)).toEqual(['x', 'y']);
    expect([...out.seated.get(8)!, ...out.seated.get(9)!].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a room holding one person takes someone new before a repeat, then the fewest meetings, then registration order', () => {
    const met = ctxOf({ met: [['solo', 'p1']] });
    // The open seat goes first (seat order); whoever is left may still join as a trio afterwards.
    const fresh = run({ seated: new Map([[1, ['solo']]]), basket: ['p1', 'p2'], ctx: met });
    expect(fresh.seated.get(1)!.slice(0, 2)).toEqual(['solo', 'p2']);
    expect(fresh.placed[0]).toBe('p2');

    const counts: Record<string, number> = { p1: 3, p2: 1, p3: 1 };
    const fewest = run({ seated: new Map([[1, ['solo']]]), basket: ['p1', 'p2', 'p3'], ctx: ctxOf(), meetingsOf: (id) => counts[id] ?? 0 });
    expect(fewest.placed[0]).toBe('p2');
    expect(fewest.seated.get(1)!.slice(0, 2)).toEqual(['solo', 'p2']);
  });

  it('a locked seat keeps its person: the room is filled around them, never emptied', () => {
    const out = run({ seated: new Map([[3, ['keeper']]]), basket: ['n'], lockedSlots: new Set(['keeper']), ctx: ctxOf() });
    expect(out.seated.get(3)).toEqual(['keeper', 'n']);
  });

  it('two people who could only meet again wait with only_repeats when the engine will not repeat them', () => {
    const out = run({ seated: new Map(), basket: ['x', 'y'], ctx: ctxOf({ met: [['x', 'y']] }) });
    expect(out.waiting).toEqual([{ userId: 'x', reason: 'only_repeats' }, { userId: 'y', reason: 'only_repeats' }]);
  });

  it('nobody to seat and nobody seated: nothing happens', () => {
    expect(run({ seated: new Map(), basket: [], ctx: ctxOf() })).toEqual({ seated: new Map(), placed: [], waiting: [] });
  });
});
