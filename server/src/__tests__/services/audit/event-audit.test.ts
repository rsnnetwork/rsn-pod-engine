// ─── Event audit trail: the writer, the reader and who writes (Part 2, Task 1) ────────────────
// recordEventAudit's two shapes (in the caller's transaction, or fire-and-forget), the 16 KB cap, the keyset
// pages with "Former member" for closed accounts, and that every action named for a handler is written by it.
// Source reads pin where each action is recorded. The SQL itself was run read-only against Postgres (task report).

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
}));
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({ io: true }),
}));

import logger from '../../../config/logger';
import {
  EVENT_AUDIT_ACTIONS, EVENT_AUDIT_DETAILS_CAP, buildAuditDetails, isEventAuditCursor, listEventAudit, recordEventAudit,
} from '../../../services/audit/event-audit';

const SESSION = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const GUEST = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mockQuery.mockReset();
  mockEmit.mockClear();
  (logger.error as jest.Mock).mockClear();
});

describe('recordEventAudit', () => {
  it('inserts one audit_log row for the event with the action and details.automatic', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: HOST }] });
    await recordEventAudit({ sessionId: SESSION, actorId: HOST, action: 'event.started', automatic: false });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_log/);
    expect(sql).toMatch(/'session'/);
    expect(params[0]).toBe(HOST);
    expect(params[1]).toBe('event.started');
    expect(params[2]).toBe(SESSION);
    expect(JSON.parse(params[3])).toMatchObject({ automatic: false, scheduleVersion: null, round: null, subjectUserIds: [], reason: null });
  });

  it('tells the host and co-hosts after a fire-and-forget write', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: HOST }] });
    await recordEventAudit({ sessionId: SESSION, actorId: HOST, action: 'event.started', automatic: false });
    expect(mockEmit).toHaveBeenCalledWith({ io: true }, [HOST], [`session:${SESSION}:audit`]);
  });

  it('with a client it is part of the caller\'s transaction and throws when the write is refused', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('disk full')) };
    await expect(recordEventAudit(
      { sessionId: SESSION, actorId: HOST, action: 'event.published', automatic: false },
      client as never,
    )).rejects.toThrow('disk full');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('with a client it writes through that client and does not tell screens before the commit', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await recordEventAudit({ sessionId: SESSION, actorId: HOST, action: 'event.published', automatic: false }, client as never);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('without a client a failed write is logged and never thrown', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(recordEventAudit({ sessionId: SESSION, actorId: null, action: 'match.repaired', automatic: true })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never rejects for a payload that cannot be stringified (circular, BigInt): it logs', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(recordEventAudit({ sessionId: SESSION, actorId: HOST, action: 'schedule.edited', automatic: false, after: circular })).resolves.toBeUndefined();
    await expect(recordEventAudit({ sessionId: SESSION, actorId: HOST, action: 'schedule.edited', automatic: false, after: { n: BigInt(1) } })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('stores a 40 KB `after` as { truncated: true }', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await recordEventAudit({
      sessionId: SESSION, actorId: HOST, action: 'schedule.edited', automatic: false,
      before: { small: true }, after: { blob: 'x'.repeat(40 * 1024) },
    });
    const stored = JSON.parse(mockQuery.mock.calls[0][1][3]);
    expect(stored.after).toEqual({ truncated: true });
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(EVENT_AUDIT_DETAILS_CAP);
  });

  it('keeps the details within the cap even when the subjects alone are too many', () => {
    const subjectUserIds = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const details = buildAuditDetails({ sessionId: SESSION, actorId: HOST, action: 'group.assigned', automatic: false, subjectUserIds });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(EVENT_AUDIT_DETAILS_CAP);
  });

  it('leaves small before/after untouched', () => {
    const d = buildAuditDetails({ sessionId: SESSION, actorId: HOST, action: 'admission.mode_changed', automatic: false, before: 'open', after: 'approval', round: 2, scheduleVersion: 3, reason: 'why' });
    expect(d).toMatchObject({ before: 'open', after: 'approval', round: 2, scheduleVersion: 3, reason: 'why' });
  });

  it('names the thirty-two actions of the brief, the three added for rows that must read true, the call link rotation and the report download (37, no repeats)', () => {
    expect(EVENT_AUDIT_ACTIONS).toHaveLength(37);
    expect(new Set(EVENT_AUDIT_ACTIONS).size).toBe(37);
    expect(EVENT_AUDIT_ACTIONS).toContain('call_link.rotated');
    expect(EVENT_AUDIT_ACTIONS).toContain('report.downloaded');
    expect(EVENT_AUDIT_ACTIONS).toEqual(expect.arrayContaining(['participant.removed', 'breakout.created', 'match.round_announced']));
  });

  it('the announce and the real start of a round are different actions, so the history never shows two identical rows', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services/orchestration/handlers/matching-flow.ts'), 'utf8');
    expect(src.match(/action: 'match.round_confirmed'/g)).toHaveLength(1);
    expect(src.match(/action: 'match.round_announced'/g)).toHaveLength(1);
  });
});

describe('listEventAudit', () => {
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
    at: new Date(Date.UTC(2026, 10, 10, 12, 0, 60 - n)),
    cursor_ts: `2026-11-10T12:00:${String(60 - n).padStart(2, '0')}.000000Z`,
    actor_id: HOST, actor_name: 'Hana Host', actor_active: true,
    action: 'event.started', details: { automatic: false }, ...over,
  });

  it('reads newest first, filtered to the event and to the audit actions, keyset on (created_at, id)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1)] });
    await listEventAudit(SESSION, {});
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/entity_type = 'session' AND a\.entity_id = \$1 AND a\.action = ANY\(\$2::text\[\]\)/);
    expect(sql).toMatch(/ORDER BY a\.created_at DESC, a\.id DESC/);
    expect(params[0]).toBe(SESSION);
    expect(params[1]).toEqual([...EVENT_AUDIT_ACTIONS]);
    expect(params[params.length - 1]).toBe(51);
  });

  it('pages with a cursor and no overlap: the next page starts strictly after the last row shown', async () => {
    const rows = [row(1), row(2), row(3)];
    mockQuery.mockResolvedValueOnce({ rows });
    const first = await listEventAudit(SESSION, { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual([rows[0].id, rows[1].id]);
    expect(first.nextCursor).toBe(`${rows[1].cursor_ts}|${rows[1].id}`);

    mockQuery.mockResolvedValueOnce({ rows: [rows[2]] });
    const second = await listEventAudit(SESSION, { limit: 2, cursor: first.nextCursor! });
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/\(a\.created_at, a\.id\) < \(\$3::timestamptz, \$4::uuid\)/);
    expect(params.slice(2, 4)).toEqual([rows[1].cursor_ts, rows[1].id]);
    expect(second.entries.map((e) => e.id)).toEqual([rows[2].id]);
    expect(second.nextCursor).toBeNull();
  });

  it('caps a page at 100 and defaults to 50', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listEventAudit(SESSION, { limit: 500 });
    expect(mockQuery.mock.calls[0][1].slice(-1)[0]).toBe(101);
    mockQuery.mockClear();
    await listEventAudit(SESSION, {});
    expect(mockQuery.mock.calls[0][1].slice(-1)[0]).toBe(51);
  });

  it('refuses a cursor that is not one', async () => {
    await expect(listEventAudit(SESSION, { cursor: "x'; DROP TABLE audit_log;--" })).rejects.toMatchObject({ statusCode: 400 });
    expect(isEventAuditCursor('nope')).toBe(false);
    expect(isEventAuditCursor('2026-11-10T12:00:59.000000Z|aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).toBe(true);
  });

  it('shows an actor whose account is closed as "Former member", and an automatic row with no actor', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        row(1, { actor_id: GUEST, actor_name: 'Gone Person', actor_active: false }),
        row(2, { actor_id: null, actor_name: null, actor_active: null, details: { automatic: true, reason: 'late_joiner', round: 3 } }),
      ],
    });
    const { entries } = await listEventAudit(SESSION, {});
    expect(entries[0].actor).toEqual({ id: GUEST, displayName: 'Former member' });
    expect(entries[1].actor).toBeNull();
    expect(entries[1]).toMatchObject({ automatic: true, reason: 'late_joiner', round: 3 });
  });

  it('names subjects in one query, and a closed or unknown subject reads "Former member"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(1, { details: { automatic: false, subjectUserIds: [HOST, GUEST] } })] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: HOST, display_name: 'Hana Host', active: true }, { id: GUEST, display_name: 'Closed One', active: false }] });
    const { entries } = await listEventAudit(SESSION, {});
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(entries[0].subjects).toEqual([
      { id: HOST, displayName: 'Hana Host' },
      { id: GUEST, displayName: 'Former member' },
    ]);
  });
});

// ─── Who writes what ─────────────────────────────────────────────────────────

const srcRoot = path.join(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8').replace(/\r\n/g, '\n');
/** The text of `export async function <name>` up to the next top-level declaration. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:^|\\n)(?:export )?async function ${name}\\b`));
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|let)|\nlet |\nconst [A-Za-z_]+ = /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('each host action records its audit entry, with the host as actor and automatic: false', () => {
  const matching = read('services/orchestration/handlers/matching-flow.ts');
  const host = read('services/orchestration/handlers/host-actions.ts');
  const bulk = read('services/orchestration/handlers/breakout-bulk.ts');

  const cases: Array<[string, () => string, string, string]> = [
    ['handleHostGenerateMatches', () => matching, 'handleHostGenerateMatches', 'match.preview_generated'],
    ['handleHostConfirmRound', () => matching, 'handleHostConfirmRound', 'match.round_confirmed'],
    ['handleHostSwapMatch', () => matching, 'handleHostSwapMatch', 'match.swapped'],
    ['handleHostExcludeFromRound', () => matching, 'handleHostExcludeFromRound', 'match.excluded'],
    ['handleHostRegenerateMatches', () => matching, 'handleHostRegenerateMatches', 'match.regenerated'],
    ['handleHostCancelPreview', () => matching, 'handleHostCancelPreview', 'match.preview_cancelled'],
    ['handleHostConfirmMatches', () => matching, 'handleHostConfirmMatches', 'match.round_announced'],
    ['handleHostStart', () => host, 'handleHostStart', 'event.started'],
    ['handleHostEnd', () => host, 'handleHostEnd', 'event.completed'],
    ['handleHostRemoveParticipant', () => host, 'handleHostRemoveParticipant', 'participant.removed'],
    ['handleHostMoveToRoom', () => host, 'handleHostMoveToRoom', 'match.moved'],
    ['handleHostCreateBreakout', () => host, 'handleHostCreateBreakout', 'breakout.created'],
    ['handleHostCreateBreakoutBulk', () => bulk, 'handleHostCreateBreakoutBulk', 'breakout.created'],
    ['handleHostAddToRoom', () => bulk, 'handleHostAddToRoom', 'match.moved'],
  ];

  it.each(cases)('%s records %s', (_label, src, fn, action) => {
    const body = fnBody(src(), fn);
    expect(body).toContain('recordEventAudit(');
    expect(body).toContain(`action: '${action}'`);
    expect(body).toContain('actorId: getUserIdFromSocket(socket)');
    expect(body).toContain('automatic: false');
  });

  it('generate records on both of its success paths (pre-planned preview and fresh)', () => {
    const body = fnBody(matching, 'handleHostGenerateMatches');
    expect(body.match(/action: 'match\.preview_generated'/g)).toHaveLength(2);
  });

  it('the REST start and end record under the event\'s host', () => {
    expect(fnBody(host, 'startSessionGuarded')).toContain("action: 'event.started'");
    const end = fnBody(host, 'endSession');
    expect(end).toContain("action: 'event.completed'");
    // A super admin may end someone else's event: the trail names who pressed it, never the event's host.
    expect(end).toContain('actorId: actor.userId');
    expect(end).not.toContain('actorId: session.hostUserId');
  });

  it('an audit call is fire-and-forget: never awaited, so a slow or failed write cannot stall or fail the action', () => {
    for (const src of [matching, host, bulk]) {
      expect(src).not.toMatch(/await recordEventAudit\(/);
    }
  });
});

describe('automatic and request-driven rows', () => {
  it('the in-person ender records event.completed with no actor, automatic', () => {
    const body = fnBody(read('services/session/in-person-ending.ts'), 'endFinishedInPersonEvents');
    expect(body).toContain("action: 'event.completed'");
    expect(body).toContain('actorId: null');
    expect(body).toContain('automatic: true');
  });

  it('repairFutureRounds records match.repaired, automatic, with the reason', () => {
    const body = fnBody(read('services/matching/matching.service.ts'), 'repairFutureRounds');
    expect(body).toContain("action: 'match.repaired'");
    expect(body).toContain('automatic: true');
    expect(body).toMatch(/actorId: null,[^}]*reason,/);
  });

  it('approve and decline record admission.request_* for the requester, under the approver', () => {
    const src = read('services/session/event-requests.service.ts');
    const approve = fnBody(src, 'approveRequest');
    const decline = fnBody(src, 'declineRequest');
    expect(approve).toContain("action: 'admission.request_approved'");
    expect(decline).toContain("action: 'admission.request_declined'");
    for (const b of [approve, decline]) {
      expect(b).toContain('subjectUserIds: [requesterId]');
      expect(b).toContain('actorId: approverId');
    }
  });
});
