// ─── Enrichment state machine — repo tests ───────────────────────────────────
// setEnrichmentState/getEnrichmentState upsert enrichment_status + friends onto
// user_intent_profiles. Two behaviors are enforced INSIDE the repo function
// (single source of truth, not left to callers): 'searching' resets error and
// stamps startedAt; any terminal status stamps completedAt.
const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

import { setEnrichmentState, getEnrichmentState } from '../../../services/onboarding/enrichment.repo';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('setEnrichmentState', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('upserts into user_intent_profiles (INSERT ... ON CONFLICT (user_id))', async () => {
    await setEnrichmentState('u1', { status: 'none' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO user_intent_profiles/i);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i);
  });

  it('setting status "searching" nulls enrichment_error and stamps enrichment_started_at', async () => {
    await setEnrichmentState('u1', { status: 'searching' });
    const [, params] = mockQuery.mock.calls[0];
    // [userId, status, source, error, startedAt, completedAt, sourceProvided, errorProvided, startedAtProvided, completedAtProvided]
    expect(params[1]).toBe('searching');
    expect(params[3]).toBeNull(); // error forced null
    expect(params[4]).toMatch(ISO_RE); // startedAt stamped
    expect(params[5]).toBeNull(); // completedAt untouched (not terminal)
    expect(params[7]).toBe(true); // errorProvided (forced)
    expect(params[8]).toBe(true); // startedAtProvided (forced)
    expect(params[9]).toBe(false); // completedAtProvided
  });

  it('searching resets error even if caller passes an explicit error value', async () => {
    await setEnrichmentState('u1', { status: 'searching', error: 'stale error should be dropped' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull();
  });

  it.each(['found', 'partial', 'not_found', 'failed'] as const)(
    'terminal status %s stamps enrichment_completed_at',
    async (status) => {
      mockQuery.mockClear();
      await setEnrichmentState('u1', { status });
      const [, params] = mockQuery.mock.calls[0];
      expect(params[1]).toBe(status);
      expect(params[5]).toMatch(ISO_RE); // completedAt stamped
      expect(params[9]).toBe(true); // completedAtProvided (forced)
    },
  );

  it('non-terminal, non-searching status ("none") only writes status — leaves other fields untouched', async () => {
    await setEnrichmentState('u1', { status: 'none' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBe(false); // sourceProvided
    expect(params[7]).toBe(false); // errorProvided
    expect(params[8]).toBe(false); // startedAtProvided
    expect(params[9]).toBe(false); // completedAtProvided
  });

  it('writes source/error when explicitly provided alongside a terminal status', async () => {
    await setEnrichmentState('u1', { status: 'failed', source: 'scrapingdog', error: 'timeout' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe('scrapingdog');
    expect(params[6]).toBe(true); // sourceProvided
    expect(params[3]).toBe('timeout');
    expect(params[7]).toBe(true); // errorProvided
  });
});

describe('getEnrichmentState', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the none-default when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const state = await getEnrichmentState('u1');
    expect(state).toEqual({ status: 'none', source: null, error: null, startedAt: null, completedAt: null });
  });

  it('maps an existing row to EnrichmentDbState', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        enrichment_status: 'found',
        enrichment_source: 'scrapingdog',
        enrichment_error: null,
        enrichment_started_at: new Date('2026-01-01T00:00:00.000Z'),
        enrichment_completed_at: new Date('2026-01-01T00:01:00.000Z'),
      }],
      rowCount: 1,
    });
    const state = await getEnrichmentState('u1');
    expect(state.status).toBe('found');
    expect(state.source).toBe('scrapingdog');
    expect(state.error).toBeNull();
    expect(state.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.completedAt).toBe('2026-01-01T00:01:00.000Z');
  });
});
