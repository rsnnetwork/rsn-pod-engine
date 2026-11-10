// ─── The one room checker (10 Nov spec, sections 05 and 07) ───────────────────────────────────────────────
//
// shared/src/events/room-check.ts decides whether a room may stand: the engine, the matching board, live swaps and
// the organiser's instant hints all ask it. Problems refuse a room (a blocked pair, a group rule, someone with no
// group, more than three people); warnings let it stand and say so (a repeat, an empty seat, a same-group
// fallback, an organiser's override). An event with no groups (rules === null) only ever meets the hard
// exclusions and the size.

import * as fs from 'fs';
import * as path from 'path';
import { checkRoom, checkRound, type RoomCheckContext } from '../../../../shared/src/events/room-check';
import type { EventGroupRules } from '../../../../shared/src/events/group-rules';

const crossRules: EventGroupRules = {
  groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
  question: 'Are you a founder or a funder?',
  allowMultiple: false,
  fallback: 'leave_unmatched',
  rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group', allowedPairs: [] }],
};

const groups: Record<string, string[]> = {
  f1: ['founder'], f2: ['founder'], f3: ['founder'],
  v1: ['funder'], v2: ['funder'],
  both: ['founder', 'funder'],
  none: [],
};

function ctxOf(overrides: Partial<RoomCheckContext> = {}, blocked: string[][] = [], met: string[][] = []): RoomCheckContext {
  const key = (a: string, b: string) => [a, b].sort().join('|');
  const blockedSet = new Set(blocked.map(([a, b]) => key(a, b)));
  const metSet = new Set(met.map(([a, b]) => key(a, b)));
  return {
    round: 1,
    rules: crossRules,
    groupsOf: (id) => groups[id] ?? [],
    hardExcluded: (a, b) => blockedSet.has(key(a, b)),
    metBefore: (a, b) => metSet.has(key(a, b)),
    maxRoomSize: 3,
    ...overrides,
  };
}

describe('checkRoom', () => {
  it('an event without groups (rules: null) never yields a group problem, whoever is in the room', () => {
    const ctx = ctxOf({ rules: null });
    for (const room of [['f1', 'f2'], ['none', 'f1'], ['none', 'v1', 'f3'], ['f1', 'f2', 'f3']]) {
      const verdict = checkRoom(ctx, room);
      expect(verdict).toEqual({ ok: true, problems: [], warnings: [] });
    }
  });

  it('without groups, a blocked pair and a room of four are still problems', () => {
    const ctx = ctxOf({ rules: null }, [['f1', 'f2']]);
    expect(checkRoom(ctx, ['f1', 'f2']).problems).toEqual([{ kind: 'hard_exclusion', userIds: ['f1', 'f2'] }]);
    expect(checkRoom(ctx, ['f3', 'v1', 'v2', 'none']).problems).toEqual([
      { kind: 'too_many', userIds: ['f3', 'v1', 'v2', 'none'] },
    ]);
  });

  it('a founder and a funder in a cross-group round pass', () => {
    expect(checkRoom(ctxOf(), ['f1', 'v1'])).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('two founders in a cross-group round are a group problem', () => {
    const verdict = checkRoom(ctxOf(), ['f1', 'f2']);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([{ kind: 'group_rule', userIds: ['f1', 'f2'] }]);
  });

  it('someone with no group, paired in a round with a rule, is a no_group problem', () => {
    const verdict = checkRoom(ctxOf(), ['none', 'v1']);
    expect(verdict.problems).toEqual([{ kind: 'no_group', userIds: ['none'] }]);
  });

  it('a round no rule covers is open: two founders meet', () => {
    expect(checkRoom(ctxOf({ round: 4 }), ['f1', 'f2']).ok).toBe(true);
    expect(checkRoom(ctxOf({ round: 4 }), ['none', 'f2']).ok).toBe(true);
  });

  it('someone in both groups meets a founder across groups', () => {
    expect(checkRoom(ctxOf(), ['both', 'f1']).ok).toBe(true);
  });

  it('a blocked pair is a problem even with the override', () => {
    const verdict = checkRoom(ctxOf({}, [['f1', 'v1']]), ['f1', 'v1'], { override: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([{ kind: 'hard_exclusion', userIds: ['f1', 'v1'] }]);
  });

  it('the override turns a group problem and a no_group problem into an override warning', () => {
    const verdict = checkRoom(ctxOf(), ['f1', 'f2'], { override: true });
    expect(verdict).toEqual({ ok: true, problems: [], warnings: [{ kind: 'override', userIds: ['f1', 'f2'] }] });
    const noGroup = checkRoom(ctxOf(), ['none', 'v1'], { override: true });
    expect(noGroup).toEqual({ ok: true, problems: [], warnings: [{ kind: 'override', userIds: ['none'] }] });
  });

  it('the override never lets a room hold more than three people', () => {
    expect(checkRoom(ctxOf(), ['f1', 'v1', 'f2', 'v2'], { override: true }).problems.map((p) => p.kind)).toContain('too_many');
  });

  it('a trio with one same-group pair in a cross-group round is a problem', () => {
    const verdict = checkRoom(ctxOf(), ['f1', 'v1', 'f2']);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([{ kind: 'group_rule', userIds: ['f1', 'f2'] }]);
  });

  it('with the fallback asked for and the event set to same-group meetings, that pair is only a warning', () => {
    const ctx = ctxOf({ rules: { ...crossRules, fallback: 'same_group_meeting' } });
    const verdict = checkRoom(ctx, ['f1', 'v1', 'f2'], { fallback: true });
    expect(verdict).toEqual({ ok: true, problems: [], warnings: [{ kind: 'same_group_fallback', userIds: ['f1', 'f2'] }] });
  });

  it('the fallback is refused when the event leaves people unmatched', () => {
    expect(checkRoom(ctxOf(), ['f1', 'f2'], { fallback: true }).problems).toEqual([{ kind: 'group_rule', userIds: ['f1', 'f2'] }]);
  });

  it('the fallback never allows a pair that shares no group (a custom rule)', () => {
    const custom: EventGroupRules = {
      ...crossRules,
      fallback: 'same_group_meeting',
      groups: [...crossRules.groups, { key: 'mentor', label: 'Mentors' }],
      rounds: [{ fromRound: 1, toRound: 3, mode: 'custom', allowedPairs: ['founder|mentor'] }],
    };
    const verdict = checkRoom(ctxOf({ rules: custom }), ['f1', 'v1'], { fallback: true });
    expect(verdict.problems).toEqual([{ kind: 'group_rule', userIds: ['f1', 'v1'] }]);
  });

  it('a pair that met in an earlier round is a repeat warning, not a problem', () => {
    const verdict = checkRoom(ctxOf({}, [], [['f1', 'v1']]), ['f1', 'v1']);
    expect(verdict).toEqual({ ok: true, problems: [], warnings: [{ kind: 'repeat', userIds: ['f1', 'v1'] }] });
  });

  it('a room with one person (or none) is a vacancy warning', () => {
    expect(checkRoom(ctxOf(), ['f1'])).toEqual({ ok: true, problems: [], warnings: [{ kind: 'vacancy', userIds: ['f1'] }] });
    expect(checkRoom(ctxOf(), []).warnings).toEqual([{ kind: 'vacancy', userIds: [] }]);
  });
});

describe('checkRound', () => {
  it('names a person seated in two rooms, and checks every room', () => {
    const { collisions, verdicts } = checkRound(ctxOf(), [
      { roomNumber: 1, memberIds: ['f1', 'v1'] },
      { roomNumber: 2, memberIds: ['f2', 'v1'] },
      { roomNumber: 3, memberIds: ['f3', 'f2'], override: true },
    ]);
    expect(collisions).toEqual(['v1', 'f2']);
    expect(verdicts.get(1)?.ok).toBe(true);
    expect(verdicts.get(3)?.warnings).toEqual([{ kind: 'override', userIds: ['f3', 'f2'] }]);
    expect([...verdicts.keys()]).toEqual([1, 2, 3]);
  });

  it('a round with nobody twice has no collisions', () => {
    expect(checkRound(ctxOf(), [{ roomNumber: 1, memberIds: ['f1', 'v1'] }]).collisions).toEqual([]);
  });
});

describe('spec 05: a group is never read from a platform role or designation', () => {
  it('room-check.ts and group-rules.ts read no role or designation', () => {
    for (const file of ['room-check.ts', 'group-rules.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../../../shared/src/events', file), 'utf8');
      // Comments and quoted words left out: a preset's question may say "a role" ("…looking for a role?").
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'/g, "''");
      expect(code).not.toMatch(/\brole\b|designation|UserRole/i);
    }
  });
});
