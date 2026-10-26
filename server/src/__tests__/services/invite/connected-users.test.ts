// ─── Connected-Users Invite Search Tests ─────────────────────────────────────
import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery }));

describe('searchConnectedUsers', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns only users with encounter_history rows shared with the requester', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u1', display_name: 'Alice', email: 'a@e.com', company: null, job_title: null, industry: null, avatar_url: null },
      ],
    });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    const result = await searchConnectedUsers('me-id', 'ali', 20);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('u1');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('encounter_history');
    expect(sql).toContain('user_a_id');
    expect(sql).toContain('user_b_id');
    expect(params).toEqual(['me-id', '%ali%', 20]);
  });

  it('returns empty list when requester has no encounter history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    const result = await searchConnectedUsers('me-id', 'xyz', 20);
    expect(result).toEqual([]);
  });

  it('excludes the requester themselves', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', 'bob', 20);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toContain('u.id != $1');
  });

  it('trims and lowercases search term for ILIKE match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', '  ALICE  ', 10);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe('%alice%');
    expect(params[2]).toBe(10);
  });

  // 26 Oct 2026 (audit 03, defect 8): the old invite search ignored blocks and let a % or _ widen the search.
  it('leaves out anyone blocked in either direction', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', 'bob', 20);
    const [sql] = mockQuery.mock.calls[0] as [string];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b WHERE \(b\.blocker_id = \$1 AND b\.blocked_id = u\.id\) OR \(b\.blocker_id = u\.id AND b\.blocked_id = \$1\)\)/);
  });

  it('still only lists active accounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', 'bob', 20);
    expect((mockQuery.mock.calls[0] as [string])[0]).toContain("u.status = 'active'");
  });

  it('matches a % or an _ the member typed as the character itself, never as a wildcard', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', '100%_Sure', 20);
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1][1]).toBe('%100\\%\\_sure%');
    await searchConnectedUsers('me-id', '%', 20);
    expect((mockQuery.mock.calls[1] as [string, unknown[]])[1][1]).toBe('%\\%%');
    await searchConnectedUsers('me-id', 'back\\slash', 20);
    expect((mockQuery.mock.calls[2] as [string, unknown[]])[1][1]).toBe('%back\\\\slash%');
  });

  it('is a parameter, never text in the query: what the member typed cannot reach the SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', "x' OR 1=1 --", 20);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('OR 1=1');
  });
});
