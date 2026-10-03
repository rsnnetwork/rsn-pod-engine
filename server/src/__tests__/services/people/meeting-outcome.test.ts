const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { recordOutcome } from '../../../services/people/meeting-outcome.service';

describe('recording what came of a meeting', () => {
  beforeEach(() => mockQuery.mockReset());

  it('stores the answer once the two are connected, without duplicate outcomes', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/AS ok/.test(sql)) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({ rows: [{ id: 'o1', created_at: new Date('2026-09-30T10:00:00Z') }] });
    });
    const out = await recordOutcome('u-a', 'u-b', 'yes', ['introduction', 'introduction', 'advice']);
    expect(out).toEqual({ id: 'o1', worthContinuing: 'yes', outcomes: ['introduction', 'advice'], createdAt: '2026-09-30T10:00:00.000Z' });
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO meeting_outcomes/.test(String(c[0])))!;
    expect(insert[1]).toEqual(['u-a', 'u-b', 'yes', ['introduction', 'advice']]);
  });

  it('checks the ordered pair (encounters and conversations store user_a < user_b)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] }).mockResolvedValueOnce({ rows: [{ id: 'o', created_at: new Date() }] });
    await recordOutcome('u-z', 'u-a', 'maybe', []);
    expect(mockQuery.mock.calls[0][1]).toEqual(['u-a', 'u-z']);
  });

  it('refuses strangers and yourself', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ok: false }] });
    await expect(recordOutcome('u-a', 'u-b', 'no', [])).rejects.toMatchObject({ statusCode: 409 });
    await expect(recordOutcome('u-a', 'u-a', 'no', [])).rejects.toMatchObject({ statusCode: 400 });
  });
});
