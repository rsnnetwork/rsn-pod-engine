import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery }));

describe('findIsolatedParticipants', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns session participants not in any active match, filtered by presenceMap', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }, { user_id: 'D' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ participant_a_id: 'A', participant_b_id: 'B', participant_c_id: null }],
    });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    const presenceMap = new Map([
      ['A', { lastHeartbeat: new Date(), socketId: 'sA' }],
      ['B', { lastHeartbeat: new Date(), socketId: 'sB' }],
      ['C', { lastHeartbeat: new Date(), socketId: 'sC' }],
      ['D', { lastHeartbeat: new Date(), socketId: 'sD' }],
    ]);
    const result = await findIsolatedParticipants('sess-1', 3, presenceMap as any);
    expect(result.sort()).toEqual(['C', 'D']);
  });

  it('excludes users absent from presenceMap', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'A' }, { user_id: 'B' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    const presenceMap = new Map([['A', { lastHeartbeat: new Date(), socketId: 'sA' }]]);
    const result = await findIsolatedParticipants('sess-1', 1, presenceMap as any);
    expect(result).toEqual(['A']);
  });

  it('excludes the host user id if provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'HOST' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    const presenceMap = new Map([
      ['A', { lastHeartbeat: new Date(), socketId: 'sA' }],
      ['HOST', { lastHeartbeat: new Date(), socketId: 'sH' }],
    ]);
    const result = await findIsolatedParticipants('sess-1', 1, presenceMap as any, 'HOST');
    expect(result).toEqual(['A']);
  });

  it('counts trio participants (participant_c) as busy when present', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }, { user_id: 'D' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ participant_a_id: 'A', participant_b_id: 'B', participant_c_id: 'C' }] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    const presenceMap = new Map(['A', 'B', 'C', 'D'].map(u => [u, { lastHeartbeat: new Date(), socketId: `s${u}` }]));
    const result = await findIsolatedParticipants('sess-1', 1, presenceMap as any);
    expect(result).toEqual(['D']);
  });
});

// Phase R1 (20 May 2026) — May-20 live-test post-mortem.
//
// Pre-fix, findIsolatedParticipants only filtered by session_participants.status,
// allowing the event host to be picked up whenever they had a session_participants
// row (which happens any time a super_admin/admin joins an event for presence
// tracking, even without explicitly opting in as a participant). The disconnect
// auto-reassign path then paired the leftover-solo participant with the host into
// a phantom match, cascading into per-client count desync, premature rating-screen
// triggers, and ghost-participant bugs.
//
// Phase R1 adds three new exclusions to the SQL: sessions.host_user_id,
// session_cohosts.user_id, and session_participants.acting_as_host=TRUE. These
// three identity classes are NEVER matchable; the auto-reassign helper must
// surface this rule at its source.

describe('findIsolatedParticipants — Phase R1 host/cohost/acting-as-host exclusion', () => {
  beforeEach(() => mockQuery.mockReset());

  it('SQL excludes session.host_user_id via NOT IN subquery', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    await findIsolatedParticipants('sess-1', 1, new Map());

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/NOT IN/);
    expect(sql).toMatch(/host_user_id\s+FROM\s+sessions/);
  });

  it('SQL excludes session_cohosts members', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    await findIsolatedParticipants('sess-1', 1, new Map());

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/session_cohosts/);
  });

  it('SQL excludes acting_as_host=TRUE participants (Phase M admin opt-in)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    await findIsolatedParticipants('sess-1', 1, new Map());

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/acting_as_host\s*=\s*TRUE/i);
  });

  it('host row pre-filtered by SQL never appears even when present in presenceMap', async () => {
    // Simulate the post-SQL-filter state: the DB query has already excluded
    // the host. The host's presence socket is still live, but they're absent
    // from the candidate set the function operates on.
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'A' }, { user_id: 'D' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { findIsolatedParticipants } = await import('../../../services/matching/isolated-participants');
    const presenceMap = new Map<string, any>([
      ['A', { lastHeartbeat: new Date(), socketId: 'sA' }],
      ['D', { lastHeartbeat: new Date(), socketId: 'sD' }],
      ['HOST_USER_ID', { lastHeartbeat: new Date(), socketId: 'sH' }],
    ]);
    const result = await findIsolatedParticipants('sess-1', 1, presenceMap);

    expect(result).not.toContain('HOST_USER_ID');
    expect(result.sort()).toEqual(['A', 'D']);
  });
});
