// ─── Who may ring whom for a video call (1 Nov 2026, 30 Oct review item 4, L12) ─────────────────────
//
// A video call needs a connection, not a held meeting: the one definition of a connection
// (connections.service.ts CONNECTION_SIGNALS_SQL), neither person blocking the other, and both still members.
// There is no admin override: ringing strangers is not wanted. Every refusal is a sentence a member reads.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import { CONNECTION_SIGNALS_SQL } from '../../../services/people/connections.service';
import { callEligibility, canVideoCall, requireConnection, CALL_REFUSALS } from '../../../services/dm/call-eligibility';

type Row = { my_status: string | null; their_status: string; their_name: string | null; blocked: boolean; connected: boolean };
const row = (over: Partial<Row> = {}): Row => ({
  my_status: 'active', their_status: 'active', their_name: 'Claus Brandt', blocked: false, connected: true, ...over,
});
const answer = (r: Row | null) => mockQuery.mockResolvedValueOnce({ rows: r ? [r] : [] });

beforeEach(() => mockQuery.mockReset());

describe('callEligibility', () => {
  it('reads the pair in one question built on the one definition of a connection, asked about the caller', async () => {
    answer(row());
    await callEligibility('u-a', 'u-b');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain(CONNECTION_SIGNALS_SQL);
    expect(params).toEqual(['u-a', 'u-b']);
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toMatch(/EXISTS \(SELECT 1 FROM people WHERE person_id = \$2\) AS connected/);
    expect(flat).toMatch(/b\.blocker_id = \$1 AND b\.blocked_id = \$2\) OR \(b\.blocker_id = \$2 AND b\.blocked_id = \$1/);
  });

  it('allows a connection who is a member and not blocked, and names them', async () => {
    answer(row());
    await expect(callEligibility('u-a', 'u-b')).resolves.toEqual({ allowed: true, name: 'Claus Brandt' });
  });

  it.each([
    ['someone with no connection to the caller', row({ connected: false }), 'not_connected'],
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

describe('canVideoCall', () => {
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

describe('requireConnection', () => {
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
