// ─── An in-person event ends itself at its start plus its length (30 Oct 2026, T12, L18) ─────────
//
// Nobody goes live for an in-person event, so nothing ever ended it: it would have sat "Upcoming" for ever. Each
// minute the server completes the scheduled in-person events whose start plus length has passed, with the
// completed fan-out (every page that shows it moves to Ended without a refresh), no LiveKit and no recap email.

import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockUpdateSessionStatus = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: (...args: unknown[]) => mockUpdateSessionStatus(...args),
  __esModule: true,
}));

const mockFanoutCompleted = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionCompleted: (...args: unknown[]) => mockFanoutCompleted(...args),
  __esModule: true,
}));

// The audit row for the ending is the audit module's own database write; its test is services/audit/event-audit.test.ts.
const mockRecordAudit = jest.fn();
jest.mock('../../../services/audit/event-audit', () => ({
  recordEventAudit: (...args: unknown[]) => mockRecordAudit(...args),
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { endFinishedInPersonEvents, IN_PERSON_ENDING_INTERVAL_MS } from '../../../services/session/in-person-ending';

const START = new Date('2026-11-20T19:00:00.000Z');
const END = new Date('2026-11-20T22:00:00.000Z');

beforeEach(() => {
  mockQuery.mockReset();
  mockRecordAudit.mockReset();
  mockUpdateSessionStatus.mockReset();
  mockUpdateSessionStatus.mockResolvedValue({});
  mockFanoutCompleted.mockReset();
  mockFanoutCompleted.mockResolvedValue(undefined);
});

describe('endFinishedInPersonEvents', () => {
  it('looks only at scheduled in-person events whose start plus length (default 60, at most 480) has passed', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(endFinishedInPersonEvents()).resolves.toEqual([]);
    const sql = (mockQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain("event_format = 'physical_event' AND status = 'scheduled' AND scheduled_at IS NOT NULL");
    expect(sql).toContain('scheduled_at + make_interval(mins =>');
    // Clamped while still numeric, THEN cast: a stored 2^31 or more would otherwise fail the whole query (fix round 1).
    expect(sql).toContain("LEAST(480, GREATEST(1, CEIL((config->>'durationMinutes')::numeric)))::int");
    expect(sql).toContain('ELSE 60 END');
    expect(sql).toContain('WHERE ends_at <= NOW()');
    expect(sql).toMatch(/LIMIT 50$/);
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled();
  });

  it('never ends a draft or an archived event (Part 2 Task 2): a draft was never announced', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await endFinishedInPersonEvents();
    const sql = (mockQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain("AND publication = 'published' AND archived_at IS NULL");
  });

  it('completes each one, stamped with its own start and end, and tells every page that shows it', async () => {
    mockQuery.mockResolvedValue({ rows: [
      { id: 'dinner', scheduled_at: START, ends_at: END },
      { id: 'walk', scheduled_at: START, ends_at: START },
    ] });
    await expect(endFinishedInPersonEvents()).resolves.toEqual(['dinner', 'walk']);
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith('dinner', SessionStatus.COMPLETED, { startedAt: START, endedAt: END });
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith('walk', SessionStatus.COMPLETED, { startedAt: START, endedAt: START });
    expect(mockFanoutCompleted.mock.calls).toEqual([['dinner'], ['walk']]);
    // Nothing else is written: no participants swept, no matches, no recap.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Each ending is attributed to nobody: the product ended it.
    expect(mockRecordAudit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ sessionId: 'dinner', actorId: null, action: 'event.completed', automatic: true }),
      expect.objectContaining({ sessionId: 'walk', actorId: null, action: 'event.completed', automatic: true }),
    ]);
  });

  it('one that fails is left for the next tick and the rest still end', async () => {
    mockQuery.mockResolvedValue({ rows: [
      { id: 'broken', scheduled_at: START, ends_at: END },
      { id: 'fine', scheduled_at: START, ends_at: END },
    ] });
    mockUpdateSessionStatus.mockImplementation(async (id: string) => {
      if (id === 'broken') throw new Error('db hiccup');
      return {};
    });
    await expect(endFinishedInPersonEvents()).resolves.toEqual(['fine']);
    expect(mockFanoutCompleted.mock.calls).toEqual([['fine']]);
  });
});

describe('the server runs it every minute, whatever the abandoned-event reaper is set to', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../services/orchestration/orchestration.service.ts'), 'utf8');

  it('schedules endFinishedInPersonEvents on its own interval', () => {
    expect(IN_PERSON_ENDING_INTERVAL_MS).toBe(60_000);
    const at = source.indexOf('await endFinishedInPersonEvents()');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(source.lastIndexOf('setInterval(', at), source.indexOf('IN_PERSON_ENDING_INTERVAL_MS);', at));
    expect(block).toContain('endFinishedInPersonEvents()');
    expect(block).not.toMatch(/abandonedEventReaper/);
  });
});
