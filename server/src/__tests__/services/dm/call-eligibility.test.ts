// ─── Who may ring whom for a video call (1 Nov 2026, 30 Oct review item 4, L12) ─────────────────────
//
// A video call needs a real mutual connection between the two, not a held meeting: a meeting request one of them
// accepted, both saying "meet again", or a 1:1 meeting the two held. A conversation on its own is not one: an
// admin may message anyone, and a host's broadcast opens a thread with every participant (fix round 1, controller
// ruling on L12 "connections only, no admin override"). Neither person may have blocked the other, and both must be
// members. Audio keeps the 9 Sep rule (calls unlocked), so for it only the block and the two accounts are asked.
// Every refusal is a sentence a member reads.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import {
  callEligibility, canVideoCall, requireConnection, requireMembers, CALL_REFUSALS, MUTUAL_CONNECTION_SQL,
} from '../../../services/dm/call-eligibility';

type Row = { my_status: string | null; their_status: string; their_name: string | null; blocked: boolean; connected: boolean };
const row = (over: Partial<Row> = {}): Row => ({
  my_status: 'active', their_status: 'active', their_name: 'Claus Brandt', blocked: false, connected: true, ...over,
});
// The database answers each account as active or not (activeMemberSql); a status here stands for that.
const answer = (r: Row | null) => mockQuery.mockResolvedValueOnce({
  rows: r ? [{ my_active: r.my_status === 'active', they_active: r.their_status === 'active', their_name: r.their_name, blocked: r.blocked, connected: r.connected }] : [],
});
const flat = (s: unknown) => String(s).replace(/\s+/g, ' ');

beforeEach(() => mockQuery.mockReset());

describe('a real mutual connection (MUTUAL_CONNECTION_SQL), asked about this pair only', () => {
  const sql = flat(MUTUAL_CONNECTION_SQL);

  it('counts a meeting request either of them accepted', () => {
    expect(sql).toMatch(/FROM user_pokes p WHERE p\.status = 'accepted' AND \(\(p\.sender_id = \$1 AND p\.recipient_id = \$2\) OR \(p\.sender_id = \$2 AND p\.recipient_id = \$1\)\)/);
  });

  it('counts both saying "meet again"', () => {
    expect(sql).toMatch(/FROM encounter_history e WHERE e\.user_a_id = LEAST\(\$1::uuid, \$2::uuid\) AND e\.user_b_id = GREATEST\(\$1::uuid, \$2::uuid\) AND e\.mutual_meet_again/);
  });

  it('counts a 1:1 meeting the two held (both joined, or calls unlocked by one), never a conversation on its own', () => {
    expect(sql).toMatch(/FROM dm_conversations c WHERE c\.user_a_id = LEAST\(\$1::uuid, \$2::uuid\) AND c\.user_b_id = GREATEST\(\$1::uuid, \$2::uuid\) AND \(c\.calls_unlocked_at IS NOT NULL OR \(c\.meeting_joined_a_at IS NOT NULL AND c\.meeting_joined_b_at IS NOT NULL\)\)/);
    // Every dm_conversations read in it is narrowed by a held meeting: an admin's or a broadcast's thread alone is not.
    const reads = sql.match(/FROM dm_conversations c WHERE [^)]*\)[^)]*\)/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(sql).not.toMatch(/direct_messages/);
  });

  it('does not count only having been at the same event (times_met without a mutual "meet again")', () => {
    expect(sql).not.toMatch(/times_met|last_session_id/);
  });
});

describe('callEligibility', () => {
  it('reads the pair in one question, with the mutual connection, the block both ways and both accounts', async () => {
    answer(row());
    await callEligibility('u-a', 'u-b');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(flat(sql)).toContain(`(${flat(MUTUAL_CONNECTION_SQL)}) AS connected`);
    expect(params).toEqual(['u-a', 'u-b']);
    expect(flat(sql)).toMatch(/b\.blocker_id = \$1 AND b\.blocked_id = \$2\) OR \(b\.blocker_id = \$2 AND b\.blocked_id = \$1/);
    // The two accounts, through the one shared reading of "an active member" (T2).
    expect(flat(sql)).toMatch(/me\.status = 'active' AS me_active/);
    expect(flat(sql)).toMatch(/t\.status = 'active' AS they_active/);
  });

  it('allows a mutual connection who is a member and not blocked, and names them', async () => {
    answer(row());
    await expect(callEligibility('u-a', 'u-b')).resolves.toEqual({ allowed: true, name: 'Claus Brandt' });
  });

  it.each([
    ['someone with no mutual connection (a conversation an admin or a broadcast opened counts for nothing)', row({ connected: false }), 'not_connected'],
    ['a pair one of whom has blocked the other', row({ blocked: true }), 'blocked'],
    ['a removed member', row({ their_status: 'removed' }), 'former_member'],
    ['a suspended member', row({ their_status: 'suspended' }), 'former_member'],
    ['a banned member', row({ their_status: 'banned' }), 'former_member'],
    ['a caller whose own account is not active', row({ my_status: 'suspended' }), 'caller_inactive'],
  ])('refuses %s', async (_label, r, reason) => {
    answer(r);
    await expect(callEligibility('u-a', 'u-b')).resolves.toMatchObject({ allowed: false, reason });
  });

  it('a block is the answer even for a removed connection, so a blocked person is never told more', async () => {
    answer(row({ blocked: true, their_status: 'removed' }));
    await expect(callEligibility('u-a', 'u-b')).resolves.toMatchObject({ allowed: false, reason: 'blocked' });
  });

  it('refuses someone who is not a member at all, and yourself, without asking the database for yourself', async () => {
    answer(null);
    await expect(callEligibility('u-a', 'u-x')).resolves.toMatchObject({ allowed: false, reason: 'not_found' });
    mockQuery.mockReset();
    await expect(callEligibility('u-a', 'u-a')).resolves.toMatchObject({ allowed: false, reason: 'self' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an admin gets no override: the role is never read', async () => {
    answer(row({ connected: false }));
    await callEligibility('u-admin', 'u-b');
    expect(String(mockQuery.mock.calls[0][0])).not.toMatch(/\brole\b/);
  });
});

describe('canVideoCall (the profile\'s and the thread\'s canCall, and the call routes, all one helper)', () => {
  it('is true only when the call is allowed', async () => {
    answer(row());
    await expect(canVideoCall('u-a', 'u-b')).resolves.toBe(true);
    answer(row({ connected: false }));
    await expect(canVideoCall('u-a', 'u-b')).resolves.toBe(false);
    answer(row({ their_status: 'removed' }));
    await expect(canVideoCall('u-a', 'u-b')).resolves.toBe(false);
    answer(row({ blocked: true }));
    await expect(canVideoCall('u-a', 'u-b')).resolves.toBe(false);
  });
});

describe('requireConnection (video)', () => {
  it('returns the person\'s name when they may be called', async () => {
    answer(row({ their_name: '  Shradha  ' }));
    await expect(requireConnection('u-a', 'u-b')).resolves.toEqual({ name: 'Shradha' });
  });

  it.each([
    ['a non-connection', row({ connected: false }), 403, CALL_REFUSALS.not_connected],
    ['a blocked pair', row({ blocked: true }), 403, CALL_REFUSALS.blocked],
    ['a removed person', row({ their_status: 'removed' }), 403, CALL_REFUSALS.former_member],
    ['a caller whose account is not active', row({ my_status: 'removed' }), 403, CALL_REFUSALS.caller_inactive],
  ])('refuses %s with a sentence', async (_label, r, status, message) => {
    answer(r);
    await expect(requireConnection('u-a', 'u-b')).rejects.toMatchObject({ statusCode: status, message });
  });

  it('refuses someone who is not a member with a 404 and yourself with a 400', async () => {
    answer(null);
    await expect(requireConnection('u-a', 'u-x')).rejects.toMatchObject({ statusCode: 404, message: CALL_REFUSALS.not_found });
    await expect(requireConnection('u-a', 'u-a')).rejects.toMatchObject({ statusCode: 400, message: CALL_REFUSALS.self });
  });

  it('every refusal is a whole sentence a member can read', () => {
    for (const sentence of Object.values(CALL_REFUSALS)) {
      expect(sentence).toMatch(/^[A-Z].*[.]$/);
      expect(sentence).not.toMatch(/RSN|session|error|forbidden/i);
    }
  });
});

describe('requireMembers (audio, whose own rule is calls unlocked)', () => {
  it('asks only the block and the two accounts: a pair without the mutual signals is not refused for it', async () => {
    answer(row({ connected: false }));
    await expect(requireMembers('u-a', 'u-b')).resolves.toEqual({ name: 'Claus Brandt' });
  });

  it.each([
    ['a blocked pair', row({ blocked: true }), CALL_REFUSALS.blocked],
    ['a removed person', row({ their_status: 'removed' }), CALL_REFUSALS.former_member],
  ])('still refuses %s', async (_label, r, message) => {
    answer(r);
    await expect(requireMembers('u-a', 'u-b')).rejects.toMatchObject({ statusCode: 403, message });
  });
});
