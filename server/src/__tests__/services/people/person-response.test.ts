const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { setResponse, clearResponse, getResponse } from '../../../services/people/person-response.service';
import { clip } from '../../../services/people/text';

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

  it('refuses yourself and unknown people', async () => {
    await expect(setResponse('u-a', 'u-a', 'saved')).rejects.toMatchObject({ statusCode: 400 });
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(setResponse('u-a', 'u-ghost', 'saved')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('clears and reads back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await clearResponse('u-a', 'u-b');
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/DELETE FROM person_responses/);
    mockQuery.mockResolvedValueOnce({ rows: [{ response: 'saved' }] });
    await expect(getResponse('u-a', 'u-b')).resolves.toBe('saved');
  });

  it('clip trims, shortens and turns blank into null', () => {
    expect(clip('  ')).toBeNull();
    expect(clip(null)).toBeNull();
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('a'.repeat(200), 20)).toHaveLength(20);
  });
});
