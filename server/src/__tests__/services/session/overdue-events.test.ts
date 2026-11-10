// ─── An overdue event closes itself (10 Nov 2026, F7, spec 12/14) ────────────────────────────────────────────────
//
// An event nobody ended stayed live, or "Upcoming" if nobody went live, for ever. Each minute the server looks for
// events whose start + length (eventDurationOf) + grace have passed and that are still live or never started:
//   report — logs and returns them as wouldClose, writes nothing (the default);
//   end    — completes a live one through the orchestrator's completion (under the session guard), and marks a
//            never-started one completed with the completed fan-out and no recap.
// In-person events (their own ender), completed, cancelled and dateless events are never touched.

import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: (...a: unknown[]) => mockInfo(...a), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../../config', () => {
  const config = { overdueEventGraceMinutes: 120, overdueEventClose: 'report' };
  return { config, default: config, __esModule: true };
});

const mockFanoutCompleted = jest.fn();
const mockFanoutAdmin = jest.fn();
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionCompleted: (...args: unknown[]) => mockFanoutCompleted(...args),
  fanoutAdminEntities: (...args: unknown[]) => mockFanoutAdmin(...args),
  __esModule: true,
}));

const mockIo = { name: 'the socket server' };
let mockIoAvailable = true;
jest.mock('../../../realtime/emit', () => ({
  getRealtimeIo: () => (mockIoAvailable ? mockIo : null),
  __esModule: true,
}));

const guarded: string[] = [];
jest.mock('../../../services/orchestration/state/session-state', () => ({
  withSessionGuard: async (sessionId: string, fn: () => Promise<unknown>) => {
    guarded.push(sessionId);
    return fn();
  },
  __esModule: true,
}));

const mockCompleteSession = jest.fn();
jest.mock('../../../services/orchestration/handlers/round-lifecycle', () => ({
  completeSession: (...args: unknown[]) => mockCompleteSession(...args),
  __esModule: true,
}));

// The audit row is the audit module's own database write (tested in services/audit/event-audit.test.ts).
const mockRecordAudit = jest.fn();
jest.mock('../../../services/audit/event-audit', () => ({
  recordEventAudit: (...args: unknown[]) => mockRecordAudit(...args),
  __esModule: true,
}));

import { closeOverdueEvents, OVERDUE_EVENT_INTERVAL_MS, OVERDUE_EVENTS_PER_TICK, OVERDUE_REPORT_REPEAT_MS } from '../../../services/session/overdue-events';

const NOW = new Date('2026-11-10T18:00:00.000Z');
const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A sessions row as the job reads it. */
interface Row { id: string; status: string; scheduled_at: Date; event_format: string | null; config: unknown }

/** A 60-minute video meeting, so its close time is start + 60 + 120 grace. */
const meeting = (id: string, status: string, startedMinutesAgo: number): Row => ({
  id, status, scheduled_at: minutesBefore(startedMinutesAgo), event_format: 'video_meeting', config: { durationMinutes: 60 },
});
let candidates: Row[] = [];
let scheduledClaims: Set<string>;

function armDatabase() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ');
    if (flat.includes('FROM sessions') && flat.startsWith('SELECT')) return { rows: candidates };
    if (flat.startsWith('UPDATE sessions')) {
      const id = params[0] as string;
      return { rows: scheduledClaims.has(id) ? [{ id }] : [] };
    }
    throw new Error(`unexpected query: ${flat}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  guarded.length = 0;
  mockIoAvailable = true;
  candidates = [];
  scheduledClaims = new Set();
  mockCompleteSession.mockResolvedValue(true);
  mockFanoutCompleted.mockResolvedValue(undefined);
  mockFanoutAdmin.mockResolvedValue(undefined);
  armDatabase();
});

describe('which events it looks at', () => {
  it('reads only live or never-started, dated, not in-person events whose start plus the grace has passed', async () => {
    await closeOverdueEvents('report', NOW);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("status IN ('scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby')");
    expect(flat).not.toMatch(/'completed'|'cancelled'/);
    expect(flat).toContain('scheduled_at IS NOT NULL');
    expect(flat).toContain("event_format IS DISTINCT FROM 'physical_event'");
    expect(flat).toContain('scheduled_at <= $1::timestamptz - make_interval(mins => $2::int)');
    expect(flat).toMatch(/ORDER BY scheduled_at LIMIT \d+$/);
    expect(params).toEqual([NOW, 120]);
  });

  // Part 2 Task 2 (D1): a draft was never announced, so nobody waits on it and it is not closed; an archived event is
  // over by definition. Both are left out where the candidates are read, and again where a never-started one is claimed.
  it('never reads a draft or an archived event', async () => {
    await closeOverdueEvents('report', NOW);
    const flat = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(flat).toContain("AND publication = 'published' AND archived_at IS NULL");
  });

  it('never claims a draft or an archived event, even one read before it became a draft', async () => {
    candidates = [meeting('never-started', 'scheduled', 400)];
    scheduledClaims.add('never-started');
    await closeOverdueEvents('end', NOW);
    const update = mockQuery.mock.calls.find(c => String(c[0]).trim().startsWith('UPDATE')) as [string, unknown[]];
    expect(update[0].replace(/\s+/g, ' '))
      .toContain("WHERE id = $1 AND status = 'scheduled' AND publication = 'published' AND archived_at IS NULL");
  });

  it('a cancelled event stays cancelled: neither the read nor the claim can match one', async () => {
    await closeOverdueEvents('report', NOW);
    const flat = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(flat).not.toMatch(/'cancelled'/);
    expect(flat).toContain("status IN ('scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby')");
  });

  it('closes only those whose start + length + grace has passed, by each event\'s own length', async () => {
    candidates = [
      meeting('meeting-overdue', 'lobby_open', 181),              // 60 + 120 = 180 minutes: past
      meeting('meeting-on-the-minute', 'lobby_open', 180),        // exactly at its close time: past
      meeting('meeting-still-in-grace', 'lobby_open', 179),       // a minute to go
      // Five 8-minute rounds and the rest: 47 minutes long (eventDurationOf), so it closes 167 minutes after its start.
      { id: 'rounds-overdue', status: 'round_transition', scheduled_at: minutesBefore(170), event_format: 'speed_networking', config: {} },
      { id: 'rounds-in-grace', status: 'round_active', scheduled_at: minutesBefore(166), event_format: 'speed_networking', config: {} },
      // A three-hour meeting, started four hours ago: still within its grace.
      { id: 'long-meeting', status: 'lobby_open', scheduled_at: minutesBefore(240), event_format: 'video_meeting', config: { durationMinutes: 180 } },
      // Config stored as text (an older row) is read as JSON.
      { id: 'text-config', status: 'scheduled', scheduled_at: minutesBefore(200), event_format: 'video_meeting', config: '{"durationMinutes":60}' },
    ];
    const result = await closeOverdueEvents('report', NOW);
    expect(result.wouldClose.sort()).toEqual(['meeting-on-the-minute', 'meeting-overdue', 'rounds-overdue', 'text-config'].sort());
    expect(result.closed).toEqual([]);
  });

  it('closes at most 50 a tick, the longest overdue first', async () => {
    candidates = Array.from({ length: 60 }, (_, i) => meeting(`e${i}`, 'scheduled', 300 + i));
    const result = await closeOverdueEvents('report', NOW);
    expect(OVERDUE_EVENTS_PER_TICK).toBe(50);
    expect(result.wouldClose).toHaveLength(50);
    expect(result.wouldClose[0]).toBe('e59');
    expect(result.wouldClose).not.toContain('e0');
  });
});

describe('report mode (the default)', () => {
  it('logs the ids it would close at info level and writes nothing', async () => {
    candidates = [meeting('live-one', 'round_active', 400), meeting('never-started', 'scheduled', 400)];
    const result = await closeOverdueEvents('report', NOW);
    expect(result).toEqual({ wouldClose: ['live-one', 'never-started'], closed: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockCompleteSession).not.toHaveBeenCalled();
    expect(mockFanoutCompleted).not.toHaveBeenCalled();
    const [fields, message] = mockInfo.mock.calls[0] as [{ wouldClose: string[]; mode: string }, string];
    expect(fields.wouldClose).toEqual(['live-one', 'never-started']);
    expect(fields.mode).toBe('report');
    expect(message).toMatch(/WOULD close/);
  });

  it('logs an unchanged list at most every 30 minutes, and a changed list at once', async () => {
    candidates = [meeting('repeat-a', 'lobby_open', 400), meeting('repeat-b', 'scheduled', 400)];
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    await closeOverdueEvents('report', NOW);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    // A minute later, the same list (in any order): not logged again.
    candidates = [candidates[1], candidates[0]];
    const again = await closeOverdueEvents('report', later(60_000));
    expect(again.wouldClose.sort()).toEqual(['repeat-a', 'repeat-b']);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    // The list changes: logged at once.
    candidates = [meeting('repeat-a', 'lobby_open', 400)];
    await closeOverdueEvents('report', later(120_000));
    expect(mockInfo).toHaveBeenCalledTimes(2);
    // Unchanged for 30 minutes since that log: logged again.
    expect(OVERDUE_REPORT_REPEAT_MS).toBe(30 * 60_000);
    await closeOverdueEvents('report', later(120_000 + OVERDUE_REPORT_REPEAT_MS - 1));
    expect(mockInfo).toHaveBeenCalledTimes(2);
    await closeOverdueEvents('report', later(120_000 + OVERDUE_REPORT_REPEAT_MS));
    expect(mockInfo).toHaveBeenCalledTimes(3);
  });

  it('logs nothing when nothing is overdue', async () => {
    candidates = [meeting('fresh', 'lobby_open', 10)];
    await expect(closeOverdueEvents('report', NOW)).resolves.toEqual({ wouldClose: [], closed: [] });
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('off', () => {
  it('reads nothing and closes nothing', async () => {
    candidates = [meeting('live-one', 'round_active', 400)];
    await expect(closeOverdueEvents('off', NOW)).resolves.toEqual({ wouldClose: [], closed: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('end mode', () => {
  it('completes each live one through the orchestrator\'s completion, under the session guard', async () => {
    candidates = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby']
      .map((status, i) => meeting(`live-${status}`, status, 400 + i));
    const result = await closeOverdueEvents('end', NOW);
    const ids = candidates.map(c => c.id);
    expect(result.closed.sort()).toEqual([...ids].sort());
    expect(mockCompleteSession.mock.calls.map(c => c[1]).sort()).toEqual([...ids].sort());
    for (const call of mockCompleteSession.mock.calls) expect(call[0]).toBe(mockIo);
    expect(guarded.sort()).toEqual([...ids].sort());
    // The completion runs its own fan-out and recap; nothing here writes the row a second time.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockFanoutCompleted).not.toHaveBeenCalled();
    // The admins' list is told by the completion's own fan-out (fanoutSessionCompleted), not here.
    expect(mockFanoutAdmin).not.toHaveBeenCalled();
  });

  it('closes a live one with no recap email: the completion is told it is an overdue close', async () => {
    candidates = [meeting('stuck-since-september', 'round_transition', 70_000)];
    await closeOverdueEvents('end', NOW);
    expect(mockCompleteSession).toHaveBeenCalledWith(mockIo, 'stuck-since-september', { reason: 'overdue', sendRecap: false });
  });

  it('counts only what it closed: a live one someone else already ended is not in closed', async () => {
    candidates = [meeting('ended-by-host-meanwhile', 'lobby_open', 400), meeting('still-stuck', 'lobby_open', 390)];
    mockCompleteSession.mockImplementation(async (_io: unknown, id: string) => id !== 'ended-by-host-meanwhile');
    const result = await closeOverdueEvents('end', NOW);
    expect(result).toEqual({ wouldClose: ['ended-by-host-meanwhile', 'still-stuck'], closed: ['still-stuck'] });
  });

  it('marks a never-started one completed only while still scheduled, with the completed fan-out and no completion run', async () => {
    candidates = [meeting('never-started', 'scheduled', 400)];
    scheduledClaims.add('never-started');
    const result = await closeOverdueEvents('end', NOW);
    expect(result.closed).toEqual(['never-started']);
    const update = mockQuery.mock.calls.find(c => String(c[0]).trim().startsWith('UPDATE')) as [string, unknown[]];
    const flat = update[0].replace(/\s+/g, ' ');
    expect(flat).toContain("SET status = 'completed', ended_at = NOW(), lobby_room_id = NULL");
    expect(flat).toContain("WHERE id = $1 AND status = 'scheduled'");
    expect(update[1]).toEqual(['never-started']);
    expect(mockFanoutCompleted).toHaveBeenCalledWith('never-started');
    // No recap: the orchestrator's completion (which sends it) is not run for an event nobody attended.
    expect(mockCompleteSession).not.toHaveBeenCalled();
  });

  it('an existing row that went live or was cancelled since it was read is left alone', async () => {
    candidates = [meeting('went-live-meanwhile', 'scheduled', 400)];
    const result = await closeOverdueEvents('end', NOW);
    expect(result).toEqual({ wouldClose: ['went-live-meanwhile'], closed: [] });
    expect(mockFanoutCompleted).not.toHaveBeenCalled();
  });

  it('one that fails is left for the next tick and the rest still close', async () => {
    candidates = [meeting('broken', 'round_active', 500), meeting('fine-live', 'lobby_open', 450), meeting('fine-scheduled', 'scheduled', 400)];
    scheduledClaims.add('fine-scheduled');
    mockCompleteSession.mockImplementation(async (_io: unknown, id: string) => {
      if (id === 'broken') throw new Error('db hiccup');
      return true;
    });
    const result = await closeOverdueEvents('end', NOW);
    expect(result.wouldClose).toEqual(['broken', 'fine-live', 'fine-scheduled']);
    expect(result.closed).toEqual(['fine-live', 'fine-scheduled']);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'broken' }), expect.any(String));
  });

  it('without a socket server a live one is not closed (and retried next tick); a never-started one still is', async () => {
    mockIoAvailable = false;
    candidates = [meeting('live-one', 'round_active', 400), meeting('never-started', 'scheduled', 400)];
    scheduledClaims.add('never-started');
    const result = await closeOverdueEvents('end', NOW);
    expect(result.closed).toEqual(['never-started']);
    expect(mockCompleteSession).not.toHaveBeenCalled();
  });
});

describe('the server runs it every minute in report mode by default', () => {
  const index = fs.readFileSync(path.join(__dirname, '../../../index.ts'), 'utf8');
  const config = fs.readFileSync(path.join(__dirname, '../../../config/index.ts'), 'utf8');

  it('schedules closeOverdueEvents on its own 60 s interval with the configured mode', () => {
    expect(OVERDUE_EVENT_INTERVAL_MS).toBe(60_000);
    const at = index.indexOf('closeOverdueEvents(config.overdueEventClose)');
    expect(at).toBeGreaterThan(-1);
    const block = index.slice(index.lastIndexOf('setInterval(', at), index.indexOf('OVERDUE_EVENT_INTERVAL_MS);', at));
    expect(block).toContain('closeOverdueEvents(config.overdueEventClose)');
    expect(block).not.toMatch(/abandonedEventReaper/);
  });

  it('reads OVERDUE_EVENT_CLOSE (default report) and OVERDUE_EVENT_GRACE_MINUTES (default 120)', () => {
    expect(config).toMatch(/overdueEventClose: \(\['off', 'report', 'end'\] as const\)\s*\.find\(m => m === process\.env\.OVERDUE_EVENT_CLOSE\) \?\? 'report'/);
    expect(config).toContain('process.env.OVERDUE_EVENT_GRACE_MINUTES ?? 120');
  });
});

describe('the event audit trail', () => {
  it('end mode records event.completed for each closed event: automatic, no actor', async () => {
    candidates = [meeting('live-one', 'round_active', 400), meeting('never-started', 'scheduled', 400)];
    scheduledClaims = new Set(['never-started']);
    await closeOverdueEvents('end', NOW);
    expect(mockRecordAudit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ sessionId: 'live-one', actorId: null, action: 'event.completed', automatic: true, reason: expect.stringContaining('Overdue') }),
      expect.objectContaining({ sessionId: 'never-started', actorId: null, action: 'event.completed', automatic: true, reason: expect.stringContaining('Overdue') }),
    ]);
  });

  it('records nothing for one that someone else already ended, or that failed to close', async () => {
    candidates = [meeting('already-ended', 'round_active', 400), meeting('fails', 'lobby_open', 401)];
    mockCompleteSession.mockImplementation(async (_io: unknown, id: string) => {
      if (id === 'fails') throw new Error('boom');
      return false;
    });
    await closeOverdueEvents('end', NOW);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('report mode records nothing', async () => {
    candidates = [meeting('live-one', 'round_active', 400)];
    await closeOverdueEvents('report', NOW);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
