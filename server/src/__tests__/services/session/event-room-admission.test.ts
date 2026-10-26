// ─── Who an event lets into its live room, and who may see it (H1, 26 Oct 2026) ──────────────────────
//
// One positive check decides whether a socket joins an event's live room: the event's host, a co-host or
// moderator, a platform admin or super admin (they may act as host), or someone whose participant row is
// not removed. Someone who left is coming back, which is recoverable; a removed row is terminal and wins
// over every role, as the registration's own REMOVED_FROM_EVENT check already does. Everyone else is
// refused (the words they read live with the join: orchestration/event-room-entry).
//
// Fix round 1: canViewSession (the live page's REST gate) counts only an ACTIVE pod membership, and lets a
// co-host in; mayClaimBreakoutRoom lets only someone in a match (or a host, co-host or admin visiting it)
// say they are in its room.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

import { canViewSession, eventRoomAdmission, mayClaimBreakoutRoom } from '../../../services/session/session-access';

const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const ME = '1d2e3f4a-5b6c-4d7e-9f80-9b0c1d2e3f4a';

type Facts = { is_host: boolean; is_cohost: boolean; participant_status: string | null };

/** What the database says about the event and this person (null: there is no such event). */
function facts(f: Partial<Facts> | null) {
  mockQuery.mockResolvedValueOnce({
    rows: f === null ? [] : [{ is_host: false, is_cohost: false, participant_status: null, ...f }],
  });
}

beforeEach(() => mockQuery.mockReset());

describe('eventRoomAdmission', () => {
  it('reads the event, its co-hosts and the person\'s participant row in one parameterised query', async () => {
    facts({});
    await eventRoomAdmission(EVENT, ME, 'member');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([EVENT, ME]);
    expect(sql).toMatch(/FROM sessions s/);
    expect(sql).toMatch(/session_cohosts/);
    expect(sql).toMatch(/session_participants/);
    expect(sql).not.toContain(EVENT);
    expect(sql).not.toContain(ME);
  });

  it.each<[string, Partial<Facts>, string | undefined]>([
    ['the event\'s host', { is_host: true }, 'member'],
    ['a co-host or moderator', { is_cohost: true }, 'member'],
    ['a platform admin who is not in the event', {}, 'admin'],
    ['a super admin who is not in the event', {}, 'super_admin'],
    ['a registered participant', { participant_status: 'registered' }, 'member'],
    ['a checked-in participant', { participant_status: 'checked_in' }, 'member'],
    ['a participant in the main room', { participant_status: 'in_lobby' }, 'member'],
    ['a participant in a breakout', { participant_status: 'in_round' }, 'member'],
    ['a participant who dropped and is reconnecting', { participant_status: 'disconnected' }, 'member'],
    ['a participant who left and is coming back', { participant_status: 'left' }, 'member'],
    ['a participant marked a no-show who turns up', { participant_status: 'no_show' }, 'member'],
    ['a participant whose token carries no role', { participant_status: 'registered' }, undefined],
  ])('admits %s', async (_who, f, role) => {
    facts(f);
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('admitted');
  });

  it.each<[string, Partial<Facts> | null, string | undefined]>([
    ['someone with no participant row and no role in the event', {}, 'member'],
    ['someone with the platform host role but nothing in this event', {}, 'host'],
    ['someone whose token carries no role and who has no row', {}, undefined],
    ['anyone, when the event does not exist', null, 'super_admin'],
  ])('refuses %s', async (_who, f, role) => {
    facts(f);
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('refused');
  });

  it.each<[string, Partial<Facts>, string]>([
    ['a removed participant', {}, 'member'],
    ['a removed participant who is an admin', {}, 'admin'],
    ['a removed participant who is a super admin', {}, 'super_admin'],
    ['a removed participant who is a co-host', { is_cohost: true }, 'member'],
    ['a removed participant who is the host', { is_host: true }, 'member'],
  ])('a removal is terminal: %s is removed', async (_who, f, role) => {
    facts({ ...f, participant_status: 'removed' });
    expect(await eventRoomAdmission(EVENT, ME, role)).toBe('removed');
  });
});

// ── canViewSession (fix round 1) ────────────────────────────────────────────

const HOST = '2e3f4a5b-6c7d-4e8f-a091-0c1d2e3f4a5b';
const POD = '3f4a5b6c-7d8e-4f90-b1a2-1d2e3f4a5b6c';

type World = {
  visibility: string; cohosts: string[]; participants: Record<string, string>; members: Record<string, string>;
};

/** A database that reads its answers from a tiny world, by what each query asks. */
function world(w: Partial<World>) {
  const full: World = { visibility: 'private', cohosts: [], participants: {}, members: {}, ...w };
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ');
    const who = params[1] as string;
    if (/FROM sessions s LEFT JOIN pods p/.test(flat)) {
      return { rows: [{ host_user_id: HOST, pod_id: POD, pod_visibility: full.visibility, is_cohost: full.cohosts.includes(who) }] };
    }
    if (/FROM session_participants WHERE session_id = \$1 AND user_id = \$2/.test(flat)) {
      const st = full.participants[who];
      return { rows: st ? [{ status: st }] : [] };
    }
    if (/FROM pod_members WHERE pod_id = \$1 AND user_id = \$2/.test(flat)) {
      const st = full.members[who];
      const activeOnly = /status = 'active'/.test(flat);
      return { rows: st && (!activeOnly || st === 'active') ? [{ role: 'member' }] : [] };
    }
    return { rows: [] };
  });
}

describe('canViewSession: who may load an event and its state (the live page\'s REST gate)', () => {
  it('keeps admins, the host, any participant who is not removed, active pod members and public pods', async () => {
    world({});
    expect(await canViewSession(ME, EVENT, 'admin')).toBe(true);
    expect(await canViewSession(ME, EVENT, 'super_admin')).toBe(true);
    expect(await canViewSession(HOST, EVENT, 'member')).toBe(true);
    for (const status of ['registered', 'in_lobby', 'left', 'disconnected', 'no_show']) {
      world({ participants: { [ME]: status } });
      expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
    }
    world({ members: { [ME]: 'active' } });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
    world({ visibility: 'public' });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
  });

  it('now lets in a co-host with no participant row and no pod membership (they used to get a 403)', async () => {
    world({ cohosts: [ME] });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
  });

  it.each(['left', 'pending_approval', 'invited', 'declined', 'removed', 'no_response'])(
    'counts only an ACTIVE pod membership: a %s membership of a private or invite-only pod is not enough',
    async (membership) => {
      for (const visibility of ['private', 'invite_only']) {
        world({ visibility, members: { [ME]: membership } });
        expect(await canViewSession(ME, EVENT, 'member')).toBe(false);
      }
    },
  );

  it('a non-active member who is a participant of the event still loads it', async () => {
    world({ members: { [ME]: 'left' }, participants: { [ME]: 'registered' } });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
  });

  it('a removed participant loads it only through an active membership or a public pod', async () => {
    world({ participants: { [ME]: 'removed' } });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(false);
    world({ participants: { [ME]: 'removed' }, members: { [ME]: 'active' } });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(true);
  });

  it('a stranger, and an event that does not exist, are refused', async () => {
    world({});
    expect(await canViewSession(ME, EVENT, 'member')).toBe(false);
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await canViewSession(ME, EVENT, 'member')).toBe(false);
  });
});

// ── mayClaimBreakoutRoom (fix round 1) ──────────────────────────────────────

const MATCH = '4a5b6c7d-8e9f-4a01-82b3-2e3f4a5b6c7d';
const ROOM_ID = `match-${EVENT}-r1-4a5b6c7d`;

type MatchFacts = { in_match: boolean; is_host: boolean; is_cohost: boolean; participant_status: string | null };
function match(f: Partial<MatchFacts> | null) {
  mockQuery.mockResolvedValueOnce({
    rows: f === null ? [] : [{ in_match: false, is_host: false, is_cohost: false, participant_status: 'in_round', ...f }],
  });
}

describe('mayClaimBreakoutRoom: who may say they are in a breakout room (presence:room_joined)', () => {
  it('reads the match, its event and the caller in one parameterised query, room id included', async () => {
    match({ in_match: true });
    await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([MATCH, EVENT, ME, ROOM_ID]);
    expect(sql).toMatch(/FROM matches m/);
    expect(sql).toMatch(/m\.room_id = \$4/);
    expect(sql).not.toContain(MATCH);
  });

  it('allows someone in the match', async () => {
    match({ in_match: true });
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(true);
  });

  it('allows the host, a co-host or an admin visiting the room', async () => {
    match({ is_host: true, participant_status: null });
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(true);
    match({ is_cohost: true });
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(true);
    match({ participant_status: null });
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'super_admin')).toBe(true);
  });

  it('refuses anyone else in the event, a removed person, and a match, event or room that do not line up', async () => {
    match({});
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(false);
    match({ in_match: true, participant_status: 'removed' });
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(false);
    match(null);
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, 'some-other-room', ME, 'member')).toBe(false);
  });

  it('refuses ids that are not uuids without asking the database', async () => {
    expect(await mayClaimBreakoutRoom(EVENT, 'not-a-match', ROOM_ID, ME, 'member')).toBe(false);
    expect(await mayClaimBreakoutRoom('not-an-event', MATCH, ROOM_ID, ME, 'member')).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // H1b (26 Oct 2026): a room is claimed only while its match runs. Every path that puts people in a room makes the
  // match active before telling them, so their own claim always finds it so; a late claim for a room they were moved
  // out of (its match completed or reassigned), or for a room whose round has ended, finds no row and is ignored.
  it('asks only about a match that is still running', async () => {
    match(null);
    expect(await mayClaimBreakoutRoom(EVENT, MATCH, ROOM_ID, ME, 'member')).toBe(false);
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toMatch(/WHERE m\.id = \$1 AND m\.session_id = \$2 AND m\.room_id = \$4 AND m\.status = 'active'/);
  });
});
