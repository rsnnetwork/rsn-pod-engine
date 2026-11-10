// ─── A host's hand-made rooms meet the engine's rules (Part 2 Task 7; spec 05, 07, 13) ───────────────────
//
// Swap, exclude, move-to-room, reassign, breakout, bulk breakout and add-to-room each make rooms the engine did not.
// Each now asks the one room checker before writing:
//   - two people one of whom blocked the other are refused, on every event, with or without an override;
//   - on an event with groups, a room this round's rule does not allow is refused in the organiser's words, unless
//     the request says override and the actor is the event's owner or a super admin (a co-host is refused), and
//     then one match.override audit row records it with the reason.
// An event without groups behaves as before except that a blocked pair is refused.

import * as fs from 'fs';
import * as path from 'path';

const gMockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => gMockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: gMockQuery })),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async () => ({ allowed: true, effectiveRole: 'host' })),
  __esModule: true,
}));

jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(async () => ({ id: 'ev', lobbyRoomId: null })),
  __esModule: true,
}));

const mockBlocks = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  getBlockedPairsForUsers: (...args: unknown[]) => mockBlocks(...args),
  __esModule: true,
}));

const mockGetEventGroupRules = jest.fn();
const mockGroupsForParticipants = jest.fn();
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: (...args: unknown[]) => mockGetEventGroupRules(...args),
  groupsForParticipants: (...args: unknown[]) => mockGroupsForParticipants(...args),
  __esModule: true,
}));

const mockGetMatchesByRound = jest.fn();
const mockGenerateSingleRound = jest.fn();
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: (...args: unknown[]) => mockGetMatchesByRound(...args),
  repairFutureRounds: jest.fn(async () => ({ regeneratedRounds: [], errors: [] })),
  resolveMatchingPolicy: () => 'within_event',
  getEligibleParticipants: jest.fn(async () => ['f1', 'f2', 'u1', 'u2']),
  generateSingleRound: (...args: unknown[]) => mockGenerateSingleRound(...args),
  __esModule: true,
}));

import { GROUP_PRESETS, SessionStatus, type EventGroupRules } from '@rsn/shared';
import { activeSessions, type ActiveSession } from '../../../services/orchestration/state/session-state';
import { handleHostGenerateMatches, handleHostSwapMatch } from '../../../services/orchestration/handlers/matching-flow';
import { judgeLiveRooms } from '../../../services/matching/live-room-guard';

const SESSION_ID = '00000000-0000-4000-8000-0000000000bb';
const OWNER = 'owner';
const COHOST = 'cohost';
const STEFAN = 'stefan';
const NAMES: Record<string, string> = { f1: 'Ann', f2: 'Bob', u1: 'Cleo', u2: 'Dev' };
const ROLES: Record<string, string> = { [OWNER]: 'member', [COHOST]: 'member', [STEFAN]: 'super_admin' };

const CROSS: EventGroupRules = {
  ...GROUP_PRESETS.founders_funders,
  rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
};

const io: any = {
  to: () => ({ emit: () => {} }),
  in: () => ({ fetchSockets: async () => [] }),
  sockets: { sockets: new Map() },
};

function socketOf(userId: string) {
  return { id: `s-${userId}`, data: { userId, role: ROLES[userId] }, rooms: new Set(), emit: jest.fn(), join: jest.fn(), leave: jest.fn() } as any;
}

function previewRound() {
  activeSessions.set(SESSION_ID, {
    sessionId: SESSION_ID, hostUserId: OWNER, config: { numberOfRounds: 5 } as any, currentRound: 0,
    status: SessionStatus.ROUND_TRANSITION, timer: null, timerSyncInterval: null, timerEndsAt: null, isPaused: false,
    pausedTimeRemaining: null, presenceMap: new Map(), pendingRoundNumber: 1, manuallyLeftRound: new Set(),
  } as ActiveSession);
  // Round 1's preview: Ann with Cleo, Bob with Dev (each a founder with a funder).
  mockGetMatchesByRound.mockResolvedValue([
    { id: 'm1', participantAId: 'f1', participantBId: 'u1', participantCId: null, status: 'scheduled' },
    { id: 'm2', participantAId: 'f2', participantBId: 'u2', participantCId: null, status: 'scheduled' },
  ]);
}

function event(opts: { groups: boolean; blocks?: string[] }) {
  mockGetEventGroupRules.mockResolvedValue(opts.groups ? CROSS : null);
  mockGroupsForParticipants.mockResolvedValue(new Map([['f1', ['founder']], ['f2', ['founder']], ['u1', ['funder']], ['u2', ['funder']]]));
  mockBlocks.mockResolvedValue(opts.blocks ?? []);
}

const sqls = () => gMockQuery.mock.calls.map(([sql]) => String(sql));
const updates = () => sqls().filter((s) => /^UPDATE matches SET participant_a_id/.test(s));
// The match.override rows (recordEventAudit passes the action as its second parameter); the swap's own
// match.swapped row (Task 1) is written beside it on every swap.
const audits = () => gMockQuery.mock.calls.filter(([sql, params]) => /INSERT INTO audit_log/.test(String(sql))
  && (params as unknown[])[1] === 'match.override');
const errorOf = (socket: { emit: jest.Mock }) => socket.emit.mock.calls.find(([e]) => e === 'error')?.[1];

beforeEach(() => {
  activeSessions.clear();
  gMockQuery.mockReset();
  gMockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/SELECT id, display_name FROM users WHERE id = ANY/.test(sql)) {
      return { rows: (params[0] as string[]).map((id) => ({ id, display_name: NAMES[id] ?? null })) };
    }
    if (/SELECT s\.host_user_id/.test(sql)) return { rows: [{ host_user_id: OWNER, role: ROLES[params[1] as string] ?? 'member' }] };
    return { rows: [], rowCount: 0 };
  });
  mockGetMatchesByRound.mockReset();
  mockGenerateSingleRound.mockReset();
  mockGenerateSingleRound.mockResolvedValue({});
  mockBlocks.mockReset();
  mockGetEventGroupRules.mockReset();
  mockGroupsForParticipants.mockReset();
});

afterAll(() => activeSessions.clear());

describe('swap, on an event without groups', () => {
  it('behaves as before: both rooms are rewritten, nothing refused, nothing audited, no group read past one', async () => {
    event({ groups: false });
    previewRound();
    const socket = socketOf(OWNER);
    // Cleo and Bob change places: Ann with Bob, Cleo with Dev.
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2' });
    expect(errorOf(socket)).toBeUndefined();
    expect(updates()).toHaveLength(2);
    expect(audits()).toHaveLength(0);
    expect(mockGroupsForParticipants).not.toHaveBeenCalled();
  });

  it('refuses a swap that would seat two people one of whom blocked the other', async () => {
    event({ groups: false, blocks: ['f2:f1'] });
    previewRound();
    const socket = socketOf(OWNER);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2' });
    expect(errorOf(socket)).toEqual({ code: 'MATCH_BLOCKED_PAIR', message: "These two people can't meet: one has blocked the other." });
    expect(updates()).toHaveLength(0);
  });

  it('a block refuses even the owner asking to override', async () => {
    event({ groups: true, blocks: ['f2:f1'] });
    previewRound();
    const socket = socketOf(OWNER);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2', override: true, reason: 'They asked' });
    expect(errorOf(socket)?.code).toBe('MATCH_BLOCKED_PAIR');
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

describe('swap, on an event with groups (founders meet funders in every round)', () => {
  it('a swap that keeps every room across groups goes through', async () => {
    event({ groups: true });
    previewRound();
    const socket = socketOf(OWNER);
    // Cleo and Dev change places: Ann with Dev, Bob with Cleo, still a founder with a funder each.
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'u2' });
    expect(errorOf(socket)).toBeUndefined();
    expect(updates()).toHaveLength(2);
    expect(audits()).toHaveLength(0);
  });

  it('a swap into a same-group pair is refused in the organiser\'s words', async () => {
    event({ groups: true });
    previewRound();
    const socket = socketOf(OWNER);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2' });
    expect(errorOf(socket)).toEqual({
      code: 'MATCH_GROUP_RULE',
      message: "Ann and Bob can't meet in this round: everyone meets someone from another group.",
    });
    expect(updates()).toHaveLength(0);
  });

  it('a co-host asking to override is refused: only the owner or a super admin may', async () => {
    event({ groups: true });
    previewRound();
    const socket = socketOf(COHOST);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2', override: true, reason: 'Same table' });
    expect(errorOf(socket)).toEqual({
      code: 'GROUP_OVERRIDE_FORBIDDEN', message: 'Only the event owner or a super admin can override group rules.',
    });
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it('the owner overriding: the swap is made and one match.override audit row says who, which round and why', async () => {
    event({ groups: true });
    previewRound();
    const socket = socketOf(OWNER);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2', override: true, reason: 'Co-founders asked to sit together' });
    expect(errorOf(socket)).toBeUndefined();
    expect(updates()).toHaveLength(2);
    expect(audits()).toHaveLength(1);
    const [sql, params] = audits()[0] as [string, unknown[]];
    expect(sql).toMatch(/'session'/);
    expect(params[0]).toBe(OWNER);
    expect(params[1]).toBe('match.override');
    expect(params[2]).toBe(SESSION_ID);
    const details = JSON.parse(params[3] as string);
    // The swap leaves both rooms within one group: Ann with Bob, and Cleo with Dev. Both are recorded.
    expect(details).toEqual({
      automatic: false, scheduleVersion: null, round: 1, before: null, reason: 'Co-founders asked to sit together',
      subjectUserIds: ['f1', 'f2', 'u1', 'u2'],
      after: {
        via: 'swap',
        rooms: [
          { memberIds: ['f1', 'f2'], problems: [{ kind: 'group_rule', userIds: ['f1', 'f2'] }] },
          { memberIds: ['u1', 'u2'], problems: [{ kind: 'group_rule', userIds: ['u1', 'u2'] }] },
        ],
      },
    });
  });

  it('a super admin who is not the owner may override too', async () => {
    event({ groups: true });
    previewRound();
    const socket = socketOf(STEFAN);
    await handleHostSwapMatch(io, socket, { sessionId: SESSION_ID, userA: 'u1', userB: 'f2', override: true });
    expect(errorOf(socket)).toBeUndefined();
    expect(audits()).toHaveLength(1);
    expect(JSON.parse((audits()[0] as [string, unknown[]])[1][3] as string).reason).toBeNull();
  });
});

describe('Match People with a plan made at Start', () => {
  function planned() {
    previewRound();
    const s = activeSessions.get(SESSION_ID)!;
    s.status = SessionStatus.LOBBY_OPEN;
    s.pendingRoundNumber = null;
  }
  const regenerated = () => mockGenerateSingleRound.mock.calls.length > 0;

  it('shows the plan as it is when nobody in it is kept apart (no groups)', async () => {
    event({ groups: false });
    planned();
    await handleHostGenerateMatches(io, socketOf(OWNER), { sessionId: SESSION_ID });
    expect(regenerated()).toBe(false);
  });

  it('makes the round again when someone blocked their planned partner after the plan was made', async () => {
    event({ groups: false, blocks: ['u1:f1'] });
    planned();
    await handleHostGenerateMatches(io, socketOf(OWNER), { sessionId: SESSION_ID });
    expect(regenerated()).toBe(true);
  });

  it("makes the round again when the organiser moved someone into their partner's group", async () => {
    event({ groups: true });
    mockGroupsForParticipants.mockResolvedValue(new Map([['f1', ['founder']], ['f2', ['founder']], ['u1', ['founder']], ['u2', ['funder']]]));
    planned();
    await handleHostGenerateMatches(io, socketOf(OWNER), { sessionId: SESSION_ID });
    expect(regenerated()).toBe(true);
  });
});

describe('the checker behind every hand-made room', () => {
  it('a room of one breaks no rule and reads nothing', async () => {
    const verdict = await judgeLiveRooms({ sessionId: SESSION_ID, round: 1, rooms: [['f1']], actorId: OWNER, request: {} });
    expect(verdict).toEqual({ ok: true, overridden: [], reason: null });
    expect(gMockQuery).not.toHaveBeenCalled();
    expect(mockGetEventGroupRules).not.toHaveBeenCalled();
  });

  it('a person with no group under a restricting rule is refused by name', async () => {
    mockGetEventGroupRules.mockResolvedValue(CROSS);
    mockGroupsForParticipants.mockResolvedValue(new Map([['f1', ['founder']]]));
    mockBlocks.mockResolvedValue([]);
    const verdict = await judgeLiveRooms({ sessionId: SESSION_ID, round: 2, rooms: [['f1', 'u1']], actorId: OWNER, request: {} });
    expect(verdict).toEqual({
      ok: false, code: 'MATCH_GROUP_RULE',
      message: "Cleo isn't in a group yet, so they can't be matched in this round: everyone meets someone from another group.",
    });
  });

  it('an inviter and their guest, or two people who met, may still be seated together by hand', async () => {
    mockGetEventGroupRules.mockResolvedValue(null);
    mockBlocks.mockResolvedValue([]);
    gMockQuery.mockImplementation(async (sql: string) => (/FROM invites/.test(sql)
      ? { rows: [{ inviter_id: 'f1', accepted_by_user_id: 'f2' }] }
      : { rows: [], rowCount: 0 }));
    const verdict = await judgeLiveRooms({ sessionId: SESSION_ID, round: 1, rooms: [['f1', 'f2']], actorId: OWNER, request: {} });
    expect(verdict.ok).toBe(true);
  });

  it('a malformed override is not read as one', async () => {
    const verdict = await judgeLiveRooms({
      sessionId: SESSION_ID, round: 1, rooms: [['f1', 'f2']], actorId: OWNER, request: { override: 'yes' },
    });
    expect(verdict).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: "That request couldn't be read. Please try again." });
  });
});

describe('every hand-made room asks the checker before it is written', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../services/orchestration/handlers', rel), 'utf8');
  const body = (src: string, start: string) => {
    const from = src.indexOf(start);
    const to = src.indexOf('\nexport async function ', from + start.length);
    return src.slice(from, to === -1 ? undefined : to);
  };

  it.each([
    ['matching-flow.ts', 'export async function handleHostSwapMatch(', /UPDATE matches SET participant_a_id/],
    ['matching-flow.ts', 'export async function handleHostExcludeFromRound(', /UPDATE matches SET participant_c_id = NULL/],
    ['host-actions.ts', 'export async function handleHostMoveToRoom(', /videoService\.createMatchRoom/],
    ['host-actions.ts', 'export async function handleHostCreateBreakout(', /videoService\.createMatchRoom/],
    ['breakout-bulk.ts', 'export async function handleHostCreateBreakoutBulk(', /videoService\.createMatchRoom/],
    ['breakout-bulk.ts', 'export async function handleHostAddToRoom(', /UPDATE matches SET \$\{slot\}/],
  ])('%s %s: judgeLiveRooms before the first write, recordMatchOverride after', (file, start, firstWrite) => {
    const fn = body(read(file), start);
    const judged = fn.indexOf('judgeLiveRooms(');
    expect(judged).toBeGreaterThan(-1);
    expect(judged).toBeLessThan(fn.search(firstWrite));
    expect(fn.indexOf('recordMatchOverride(')).toBeGreaterThan(fn.search(firstWrite));
  });

  it('reassign pairs the target only with someone the checker accepts', () => {
    const fn = body(read('host-actions.ts'), 'export async function handleHostReassign(');
    expect(fn).toMatch(/partner = candidates\.find\(id => checkRoom\(roomCtx, \[targetId, id\], \{ fallback: true \}\)\.ok\)/);
    expect(fn.indexOf('loadLiveRoomContext(')).toBeLessThan(fn.indexOf('INSERT INTO matches'));
  });
});
