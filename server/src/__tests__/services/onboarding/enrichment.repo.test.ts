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

// Fix round 1 (21 Oct 2026): the state never said WHICH address its lookup ran
// for, so onboarding v2 guessed it from the member's row, and an address the
// member changed on their profile page was read as one already looked up. The
// address now travels with the state it describes, in inferred_profile.lastLookup.
describe('setEnrichmentState: the address the lookup ran for', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('records it beside the state, with the time of the write', async () => {
    await setEnrichmentState('u1', { status: 'searching', linkedinUrl: 'https://www.linkedin.com/in/ana' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/jsonb_build_object\('lastLookup', \$12::jsonb\)/);
    expect(params[10]).toBe(true);
    const lookup = JSON.parse(params[11] as string);
    expect(lookup.linkedinUrl).toBe('https://www.linkedin.com/in/ana');
    expect(lookup.at).toBe(params[4]); // the same instant the state was stamped with
  });

  it('a terminal state carries its address and its completion time', async () => {
    await setEnrichmentState('u1', { status: 'not_found', linkedinUrl: 'https://www.linkedin.com/in/ana' });
    const [, params] = mockQuery.mock.calls[0];
    expect(JSON.parse(params[11] as string)).toEqual({ linkedinUrl: 'https://www.linkedin.com/in/ana', at: params[5] });
  });

  it('a lookup for no address records that as null', async () => {
    await setEnrichmentState('u1', { status: 'not_found', linkedinUrl: null });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[10]).toBe(true);
    expect(JSON.parse(params[11] as string).linkedinUrl).toBeNull();
  });

  it('a state written without an address removes the old one, so it can never describe another lookup', async () => {
    await setEnrichmentState('u1', { status: 'found', source: 'scrapingdog' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params[10]).toBe(false);
    expect(sql).toMatch(/inferred_profile, '\{\}'::jsonb\) - 'lastLookup'/);
  });

  it('keeps the existing parameters where they were', async () => {
    await setEnrichmentState('u1', { status: 'failed', source: 'scrapingdog', error: 'timeout', linkedinUrl: 'https://www.linkedin.com/in/ana' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params.slice(0, 4)).toEqual(['u1', 'failed', 'scrapingdog', 'timeout']);
  });
});
