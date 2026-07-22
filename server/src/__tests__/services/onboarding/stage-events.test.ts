// ─── Onboarding stage-event telemetry — repo tests ──────────────────────────
// record() persists one per-stage timing/failure event for the admin
// inspector (spec: "time taken for each stage", "failed searches and
// errors"). It must NEVER throw — a telemetry write failing (DB down, etc.)
// must never affect the onboarding flow it's observing. listForUser() reads
// the trail back out for a given user, most recent first.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import logger from '../../../config/logger';
import { record, listForUser } from '../../../services/onboarding/stage-events.repo';

describe('record', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('inserts into onboarding_stage_events with the right shape', async () => {
    await record('u1', 'enrich_started', { provider: 'scrapingdog' }, 1234);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO onboarding_stage_events/i);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('enrich_started');
    expect(JSON.parse(params[2])).toEqual({ provider: 'scrapingdog' });
    expect(params[3]).toBe(1234);
  });

  it('defaults detail to {} and durationMs to null when omitted', async () => {
    await record('u1', 'chat_started');

    const [, params] = mockQuery.mock.calls[0];
    expect(JSON.parse(params[2])).toEqual({});
    expect(params[3]).toBeNull();
  });

  it('accepts every stage in the CHECK constraint', async () => {
    const stages = [
      'enrich_started', 'enrich_found', 'enrich_partial', 'enrich_not_found', 'enrich_failed',
      'photo_captured', 'photo_failed', 'chat_started', 'confirmed', 'fallback_form', 'extract_failed',
    ] as const;
    for (const stage of stages) {
      mockQuery.mockClear();
      await record('u1', stage);
      expect(mockQuery.mock.calls[0][1][1]).toBe(stage);
    }
  });

  it('never throws: a DB failure is caught and logged, not propagated', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));

    await expect(record('u1', 'enrich_failed', { provider: 'scrapingdog' }, 500)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('listForUser', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns [] when the user has no stage events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const events = await listForUser('u1');
    expect(events).toEqual([]);
  });

  it('maps rows to StageEvent (camelCase), most recent first', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'evt-2',
          user_id: 'u1',
          stage: 'enrich_found',
          detail: { provider: 'scrapingdog' },
          duration_ms: 900,
          created_at: new Date('2026-07-01T00:00:05.000Z'),
        },
        {
          id: 'evt-1',
          user_id: 'u1',
          stage: 'enrich_started',
          detail: { provider: 'scrapingdog' },
          duration_ms: null,
          created_at: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      rowCount: 2,
    });

    const events = await listForUser('u1');

    expect(events).toEqual([
      {
        id: 'evt-2',
        userId: 'u1',
        stage: 'enrich_found',
        detail: { provider: 'scrapingdog' },
        durationMs: 900,
        createdAt: '2026-07-01T00:00:05.000Z',
      },
      {
        id: 'evt-1',
        userId: 'u1',
        stage: 'enrich_started',
        detail: { provider: 'scrapingdog' },
        durationMs: null,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM onboarding_stage_events/i);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(params).toEqual(['u1']);
  });

  it('defaults a null detail to {}', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'evt-1', user_id: 'u1', stage: 'chat_started', detail: null,
        duration_ms: null, created_at: new Date('2026-07-01T00:00:00.000Z'),
      }],
      rowCount: 1,
    });

    const [event] = await listForUser('u1');
    expect(event.detail).toEqual({});
  });
});
