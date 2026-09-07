// Auth-token housekeeping (7 Sep 2026, W1b).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { pruneExpiredAuthTokens } from '../../../services/maintenance/token-cleanup';

beforeEach(() => mockQuery.mockReset());

describe('pruneExpiredAuthTokens', () => {
  it('deletes long-expired refresh tokens and used/expired old magic links, and reports counts', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 3 })  // refresh_tokens delete
      .mockResolvedValueOnce({ rowCount: 5 }); // magic_links delete

    const counts = await pruneExpiredAuthTokens();

    expect(counts).toEqual({ refreshTokens: 3, magicLinks: 5 });
    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls[0]).toMatch(/DELETE FROM refresh_tokens WHERE expires_at < NOW\(\) - INTERVAL '30 days'/);
    expect(sqls[1]).toMatch(/DELETE FROM magic_links/);
    expect(sqls[1]).toMatch(/used_at IS NOT NULL OR expires_at < NOW\(\)/);
    expect(sqls[1]).toMatch(/created_at < NOW\(\) - INTERVAL '7 days'/);
  });

  it('never deletes a live, unused magic link (bounded by used/expired AND age)', async () => {
    // The WHERE requires the link to be used-or-expired; a fresh unused link
    // (expires_at in the future, used_at null) cannot match.
    mockQuery.mockResolvedValue({ rowCount: 0 });
    await pruneExpiredAuthTokens();
    const mlSql = String(mockQuery.mock.calls[1][0]);
    expect(mlSql).toMatch(/\(used_at IS NOT NULL OR expires_at < NOW\(\)\)/);
  });
});
