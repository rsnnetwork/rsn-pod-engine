// ─── Platform-wide people search (13 Aug 2026, Task C1) ──────────────────────
//
// Claus: "No way to search for a known person on the platform." The only
// member-facing search was /users/connected, over people you had ALREADY met,
// which is useless for finding someone you have not. (/users/search exists
// but is admin-only moderation and returns emails; it stays that way.)
//
// Ali's decision: every active, onboarded member is findable by name, job
// title and company. The result is deliberately THIN: name, title, company,
// location, photo. Everything else keeps the gates it already sits behind.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { searchMembers } from '../../../services/user/user-search.service';

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

const sqlOf = () => String(mockQuery.mock.calls[0][0]);

describe('searchMembers', () => {
  it('searches name, job title and company', async () => {
    await searchMembers('me', 'claus', 20);
    expect(sqlOf()).toMatch(/display_name ILIKE/);
    expect(sqlOf()).toMatch(/job_title ILIKE/);
    expect(sqlOf()).toMatch(/company ILIKE/);
  });

  it('only ever returns active, onboarded members', async () => {
    await searchMembers('me', 'claus', 20);
    expect(sqlOf()).toMatch(/u\.status = 'active'/);
    expect(sqlOf()).toMatch(/onboarding_completed = true/);
  });

  it('never returns the searcher, or anyone in a block relationship either way', async () => {
    await searchMembers('me', 'claus', 20);
    expect(sqlOf()).toMatch(/u\.id <> \$1/);
    expect(sqlOf()).toMatch(/user_blocks/);
    expect(sqlOf()).toMatch(/blocker_id = \$1/);
    expect(sqlOf()).toMatch(/blocked_id = \$1/);
  });

  it('puts a name match first: someone searching "Claus" means the person, not a company', async () => {
    await searchMembers('me', 'claus', 20);
    expect(sqlOf()).toMatch(/ORDER BY[\s\S]*display_name ILIKE \$2\) DESC/);
  });

  it('caps the result set however large a limit is asked for', async () => {
    await searchMembers('me', 'claus', 5000);
    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBeLessThanOrEqual(50);
  });

  it('defaults a missing or nonsense limit to something sane', async () => {
    await searchMembers('me', 'claus', 0);
    expect(mockQuery.mock.calls[0][1][2]).toBeGreaterThan(0);
  });

  it('returns nothing for a blank or one-character query, without touching the db', async () => {
    expect(await searchMembers('me', '', 20)).toEqual([]);
    expect(await searchMembers('me', '   ', 20)).toEqual([]);
    expect(await searchMembers('me', 'c', 20)).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('escapes ILIKE wildcards so "%" cannot list the whole network', async () => {
    await searchMembers('me', '%%', 20);
    const params = mockQuery.mock.calls[0]?.[1];
    // Either refused outright, or the wildcards were escaped in the pattern.
    if (params) expect(params[1]).toMatch(/\\%/);
  });

  it('does not leak bio, email or LinkedIn in a search result', async () => {
    await searchMembers('me', 'claus', 20);
    const selected = sqlOf().split(/\bFROM\b/)[0];
    expect(selected).not.toMatch(/email/);
    expect(selected).not.toMatch(/bio/);
    expect(selected).not.toMatch(/linkedin/);
  });

  it('returns the thin shape the page renders', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      userId: 'u-2', displayName: 'Claus Sønderskov', avatarUrl: '/api/users/u-2/avatar',
      jobTitle: 'CEO', company: 'Vokt', location: 'Copenhagen',
    }] });
    const r = await searchMembers('me', 'claus', 20);
    expect(r).toEqual([{
      userId: 'u-2', displayName: 'Claus Sønderskov', avatarUrl: '/api/users/u-2/avatar',
      jobTitle: 'CEO', company: 'Vokt', location: 'Copenhagen',
    }]);
  });
});
