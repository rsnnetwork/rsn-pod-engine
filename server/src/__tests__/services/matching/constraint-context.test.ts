// ─── loadRoomCheckContext: what the one room checker knows about an event (10 Nov 2026 spec, Part 2 Task 5) ─
// The hard exclusions are the ones generateSingleRound gives the engine (an inviter and their invitee, a block
// either way, a report not dismissed), "met before" is this event's earlier algorithm rounds plus what the caller
// adds, and an event without groups reads no group membership at all.

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockRules = jest.fn();
const mockGroups = jest.fn();
jest.mock('../../../services/session/event-groups.service', () => ({
  __esModule: true,
  getEventGroupRules: (...a: unknown[]) => mockRules(...a),
  groupsForParticipants: (...a: unknown[]) => mockGroups(...a),
}));

const sqlSeen: string[] = [];
jest.mock('../../../db', () => ({
  __esModule: true,
  query: jest.fn(async (raw: string, params: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    sqlSeen.push(sql);
    if (/FROM session_participants/.test(sql)) return { rows: ['a', 'b', 'c', 'd'].map((user_id) => ({ user_id })) };
    if (/FROM invites/.test(sql)) return { rows: [{ inviter_id: 'b', accepted_by_user_id: 'a' }, { inviter_id: null, accepted_by_user_id: 'c' }] };
    if (/FROM user_blocks/.test(sql)) return { rows: [{ a: 'd', b: 'c' }] };
    if (/FROM violations/.test(sql)) return { rows: [{ a: 'a', b: 'd' }] };
    if (/FROM matches/.test(sql)) {
      expect(params).toEqual(['ev', 3]);
      return { rows: [{ a: 'a', b: 'c', c: null }, { a: 'b', b: 'd', c: 'c' }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
}));

import { loadRoomCheckContext } from '../../../services/matching/constraint-context';
import { checkRoom } from '@rsn/shared';

beforeEach(() => {
  sqlSeen.length = 0;
  mockRules.mockResolvedValue(null);
  mockGroups.mockResolvedValue(new Map());
});

describe('loadRoomCheckContext', () => {
  it('an event without groups: no rules, nobody has a group, and no membership is read', async () => {
    const ctx = await loadRoomCheckContext('ev', 3);
    expect(ctx.rules).toBeNull();
    expect(ctx.groupsOf('a')).toEqual([]);
    expect(ctx.maxRoomSize).toBe(3);
    expect(mockGroups).not.toHaveBeenCalled();
    expect(checkRoom(ctx, ['a', 'c']).problems).toEqual([]);
  });

  it('hard exclusions: an inviter and their invitee, a block, a report, whichever way round they are asked', async () => {
    const ctx = await loadRoomCheckContext('ev', 3);
    expect(ctx.hardExcluded('a', 'b')).toBe(true);
    expect(ctx.hardExcluded('b', 'a')).toBe(true);
    expect(ctx.hardExcluded('c', 'd')).toBe(true);
    expect(ctx.hardExcluded('d', 'a')).toBe(true);
    expect(ctx.hardExcluded('a', 'c')).toBe(false);
  });

  it('met before: the earlier rounds of this event (a trio is three pairs), plus the pairs the caller adds', async () => {
    const ctx = await loadRoomCheckContext('ev', 3, { earlierPairs: new Set(['a:d']) });
    expect(ctx.metBefore('c', 'a')).toBe(true);
    expect(ctx.metBefore('b', 'd')).toBe(true);
    expect(ctx.metBefore('b', 'c')).toBe(true);
    expect(ctx.metBefore('d', 'c')).toBe(true);
    expect(ctx.metBefore('d', 'a')).toBe(true);
    expect(ctx.metBefore('a', 'b')).toBe(false);
    const earlier = sqlSeen.find((s) => /FROM matches/.test(s));
    expect(earlier).toMatch(/round_number < \$2 AND status IN \('completed', 'active'\) AND is_manual = FALSE/);
  });

  it('an event with groups reads each person\'s groups for the checker', async () => {
    mockRules.mockResolvedValue({
      groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
      question: 'q', allowMultiple: false, fallback: 'leave_unmatched',
      rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
    });
    mockGroups.mockResolvedValue(new Map([['a', ['founder']], ['c', ['founder']], ['b', ['funder']]]));
    const ctx = await loadRoomCheckContext('ev', 3);
    expect(ctx.groupsOf('a')).toEqual(['founder']);
    expect(ctx.groupsOf('d')).toEqual([]);
    expect(checkRoom(ctx, ['a', 'c']).problems).toEqual([{ kind: 'group_rule', userIds: ['a', 'c'] }]);
    expect(checkRoom(ctx, ['c', 'b']).ok).toBe(true);
  });
});
