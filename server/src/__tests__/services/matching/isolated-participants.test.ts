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
