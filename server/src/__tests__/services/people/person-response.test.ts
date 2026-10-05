const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { setResponse, clearResponse, getResponse } from '../../../services/people/person-response.service';

describe('Save / Pass on a person', () => {
  beforeEach(() => mockQuery.mockReset());

  it('upserts one row per pair, so Save then Pass leaves Pass', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /SELECT id FROM users/.test(sql) ? [{ id: 'u-b' }] : [] }));
    await setResponse('u-a', 'u-b', 'saved');
    await setResponse('u-a', 'u-b', 'passed');
    const upserts = mockQuery.mock.calls.filter(c => /INSERT INTO person_responses/.test(String(c[0])));
    expect(upserts).toHaveLength(2);
    expect(String(upserts[1][0])).toMatch(/ON CONFLICT \(user_id, target_user_id\)/);
    expect(upserts[1][1]).toEqual(['u-a', 'u-b', 'passed']);
  });

  it('refuses yourself and unknown people, and writes nothing for either', async () => {
    await expect(setResponse('u-a', 'u-a', 'saved')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled(); // refused before the database is touched
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(setResponse('u-a', 'u-ghost', 'saved')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO person_responses/.test(String(c[0])))).toBe(false);
  });

  it('clears the answer about one person only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await clearResponse('u-a', 'u-b');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/DELETE FROM person_responses/);
    // Scoped to this member AND this person. Without the second condition an undo
    // would wipe every Save and Pass the member has made.
    expect(String(sql).replace(/\s+/g, ' ')).toMatch(/WHERE user_id = \$1 AND target_user_id = \$2/);
    expect(params).toEqual(['u-a', 'u-b']);
  });

  it('reads back this member\'s answer about this person, or null when there is none', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ response: 'saved' }] });
    await expect(getResponse('u-a', 'u-b')).resolves.toBe('saved');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toMatch(/WHERE user_id = \$1 AND target_user_id = \$2/);
    expect(params).toEqual(['u-a', 'u-b']);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getResponse('u-a', 'u-c')).resolves.toBeNull();
  });
});
