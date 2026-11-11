// ─── Session Access Control Tests ────────────────────────────────────────────
// Unit tests for canViewSession() — enforces read-access gate on session detail.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery }));

describe('canViewSession', () => {
  beforeEach(() => mockQuery.mockReset());

  it('grants access to admin regardless of pod membership', async () => {
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('admin-id', 'sess-1', 'admin');
    expect(result).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('grants access to super_admin', async () => {
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('sa-id', 'sess-1', 'super_admin');
    expect(result).toBe(true);
  });

  it('grants access to the session host', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'me', pod_id: 'pod-1', pod_visibility: 'invite_only' }],
    });
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(true);
  });

  it('grants access to a registered participant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'registered' }] });
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(true);
  });

  it('denies access to a removed participant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'removed' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no pod membership
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(false);
  });

  it('grants access to pod members of invite_only pods', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not registered
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }] }); // pod member
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(true);
  });

  it('grants access to any authenticated user for public pod', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'public' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not registered
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not pod member
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(true);
  });

  it('denies access to non-member of private pod', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'private' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'sess-1', 'member');
    expect(result).toBe(false);
  });

  it('returns false for a non-existent session', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { canViewSession } = await import('../../../services/session/session-access');
    const result = await canViewSession('me', 'missing', 'member');
    expect(result).toBe(false);
  });

  // Part 3 Task 3 (controller ruling after the 11 Nov prod smoke): an event that follows its pod (NULL visibility) opens
  // to someone on its waiting list, read last, only for a row still 'waiting'.
  it('grants access to someone waiting on a NULL event in an invite-only pod, and reads only a waiting row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no place
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a pod member
    mockQuery.mockResolvedValueOnce({ rows: [{ waiting: 1 }] }); // on the waiting list
    const { canViewSession } = await import('../../../services/session/session-access');
    expect(await canViewSession('me', 'sess-1', 'member', { eventPage: true })).toBe(true);
    const [sql, params] = mockQuery.mock.calls[3];
    expect(String(sql).replace(/\s+/g, ' ')).toContain("FROM event_waitlist WHERE session_id = $1 AND user_id = $2 AND status = 'waiting'");
    expect(params).toEqual(['sess-1', 'me']);
  });

  it('a left, lapsed or removed waiting row (no waiting row) gives nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { canViewSession } = await import('../../../services/session/session-access');
    expect(await canViewSession('me', 'sess-1', 'member', { eventPage: true })).toBe(false);
  });

  it('only the event page asks: any other read (the live state) never reads the waiting list and refuses', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'invite_only' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ waiting: 1 }] });
    const { canViewSession } = await import('../../../services/session/session-access');
    expect(await canViewSession('me', 'sess-1', 'member')).toBe(false);
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('event_waitlist'))).toBe(false);
  });

  it('a draft never opens to someone waiting (the waiting list is not even read)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other', pod_id: 'pod-1', pod_visibility: 'public', publication: 'draft' }] });
    const { canViewSession } = await import('../../../services/session/session-access');
    expect(await canViewSession('me', 'sess-1', 'member')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
