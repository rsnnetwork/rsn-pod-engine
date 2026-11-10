// ─── A draft is seen only by the people who run it; an archived event leaves the default lists (Part 2 Task 2) ─────
//
// D1: sessions.publication and sessions.archived_at sit beside status. Every member-facing list ANDs in
// eventListedForSql (not archived, and published or run by the viewer); the event page, the registration and the
// live room answer anyone who does not run a draft exactly as for an id that does not exist. An event whose
// registration opens later holds back everyone it would take, in words. A production-shaped event (published, never
// archived, no opening time) answers GET /sessions/:id exactly as before, plus the additive fields.
// The SQL itself was run against Postgres for the task report (probe); this file holds the shapes and the answers.

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../../config', () => {
  const config = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test',
    isDev: false, isProd: false, isTest: true,
  };
  return { config, default: config, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

type Answer = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<Promise<Answer>, [string, unknown[]?]>();
const mockClient = { query: (sql: string, params?: unknown[]) => mockQuery(sql, params) };
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(mockClient),
  __esModule: true,
}));
const mockAudit = jest.fn();
jest.mock('../../../services/audit/event-audit', () => ({
  recordEventAudit: (...args: unknown[]) => mockAudit(...args),
  emitEventAuditChanged: jest.fn(),
  __esModule: true,
}));

import { UserRole } from '@rsn/shared';
import {
  eventListedForSql, archivedEventsSql, visibleEventsSql, publicEventsSql, canSeeEvent, canRegister, type EventAccessFacts,
} from '../../../services/session/event-access';
import { canViewSession, eventRoomAdmission } from '../../../services/session/session-access';
import { listSessions, registerParticipant, hardDeleteSession } from '../../../services/session/session.service';
import sessionRoutes from '../../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

const SRC = path.join(__dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const EVENT = '5e550000-0000-4000-8000-0000000000d1';
const RANDOM = '5e550000-0000-4000-8000-0000000000ff';
const HOST = '05e70000-0000-4000-8000-0000000000a1';
const MEMBER = '05e70000-0000-4000-8000-0000000000b2';

beforeEach(() => {
  mockQuery.mockReset();
  mockAudit.mockReset();
});

// ── The fragments ───────────────────────────────────────────────────────────

describe('the list fragments', () => {
  it('eventListedForSql: not archived, and published or run by the viewer (host or co-host)', () => {
    expect(flat(eventListedForSql('s', '$2'))).toBe(
      "(s.archived_at IS NULL AND (s.publication = 'published' OR s.host_user_id = $2 "
      + 'OR EXISTS (SELECT 1 FROM session_cohosts el_c WHERE el_c.session_id = s.id AND el_c.user_id = $2)))',
    );
  });

  it('visibleEventsSql (Events list, For You\'s next event, a circle page) carries it', () => {
    expect(visibleEventsSql('s', '$1')).toContain(eventListedForSql('s', '$1'));
  });

  it('publicEventsSql (nobody asking) lists no draft and no archived event', () => {
    expect(flat(publicEventsSql('s'))).toMatch(/AND s\.archived_at IS NULL AND s\.publication = 'published'$/);
  });

  it('archivedEventsSql: archived, and the viewer ran it or held a place in it', () => {
    const sql = flat(archivedEventsSql('s', '$1'));
    expect(sql).toContain('s.archived_at IS NOT NULL');
    expect(sql).toContain('s.host_user_id = $1');
    expect(sql).toContain('session_cohosts');
    expect(sql).toContain("ae_p.status <> 'removed'");
  });

  it('refuses anything but an alias and a placeholder', () => {
    expect(() => eventListedForSql('s; DROP', '$1')).toThrow();
    expect(() => eventListedForSql('s', '1')).toThrow();
  });
});

// ── listSessions ────────────────────────────────────────────────────────────

describe('listSessions', () => {
  beforeEach(() => {
    mockQuery.mockImplementation(async (sql: string) =>
      (sql.includes('COUNT(*)') ? { rows: [{ count: '0' }] } : { rows: [] }));
  });
  const sent = () => mockQuery.mock.calls.map(([sql, params]) => ({ sql: flat(sql), params }));

  it('a member\'s Events list leaves out other people\'s drafts and every archived event', async () => {
    await listSessions({ userId: MEMBER, viewerId: MEMBER });
    expect(sent()[0].sql).toContain(flat(eventListedForSql('s', '$1')));
    expect((sent()[0].params as unknown[]).slice(0, 1)).toEqual([MEMBER]);
  });

  it('a member reading a pod\'s events gets the same rule, with themselves as the viewer', async () => {
    await listSessions({ podId: 'pod-1', viewerId: MEMBER, viewerIsAdmin: false });
    expect(sent()[0].sql).toContain(`s.pod_id = $1 AND ${flat(eventListedForSql('s', '$2'))}`);
    expect((sent()[0].params as unknown[]).slice(0, 2)).toEqual(['pod-1', MEMBER]);
  });

  it('an admin\'s lists are today\'s (every event, drafts included)', async () => {
    await listSessions({ podId: 'pod-1', viewerId: 'admin', viewerIsAdmin: true });
    await listSessions({ isAdmin: true, viewerId: 'admin', viewerIsAdmin: true });
    for (const { sql } of sent()) expect(sql.slice(sql.indexOf(' WHERE '))).not.toMatch(/publication|archived_at/);
  });

  it('archived=1: a member gets the archived events they ran or held a place in; an admin every archived one', async () => {
    await listSessions({ userId: MEMBER, viewerId: MEMBER, archived: true });
    expect(sent()[0].sql).toContain(flat(archivedEventsSql('s', '$1')));
    expect(sent()[0].sql).not.toContain('s.archived_at IS NULL');
    mockQuery.mockClear();
    await listSessions({ podId: 'pod-1', viewerId: MEMBER, archived: true });
    expect(sent()[0].sql).toContain(flat(archivedEventsSql('s', '$2')));
    mockQuery.mockClear();
    await listSessions({ isAdmin: true, viewerIsAdmin: true, archived: true });
    expect(sent()[0].sql).toContain('WHERE 1=1 AND s.archived_at IS NOT NULL');
  });

  it('nobody asking: public events only, never a draft or an archived one', async () => {
    await listSessions({});
    expect(sent()[0].sql).toContain("s.publication = 'published'");
    mockQuery.mockClear();
    await listSessions({ archived: true });
    expect(sent()[0].sql).toContain('AND FALSE');
  });

  it('an older caller that names a pod and no viewer reads the pod as before', async () => {
    await listSessions({ podId: 'pod-123' });
    expect(sent()[0].sql).toBe('SELECT COUNT(*) as count FROM sessions s WHERE 1=1 AND s.pod_id = $1');
  });
});

// ── The other places that name upcoming events ──────────────────────────────

describe('every other list that names an event', () => {
  it('For You\'s next event and a circle page read visibleEventsSql, which carries the rule', () => {
    expect(read('services/matching/platform-match.service.ts')).toMatch(/AND \$\{visibleEventsSql\('s', '\$1'\)\}/);
    expect(read('services/circle/circle.service.ts')).toMatch(/\$3::boolean OR \$\{visibleEventsSql\('s', '\$2'\)\}/);
  });

  it('a person\'s brief names only events both may see as listed, the viewer being $1', () => {
    const brief = read('services/people/person-brief.service.ts');
    expect(brief).toMatch(/AND s\.status = 'scheduled' AND s\.scheduled_at > NOW\(\)\s+AND \$\{eventListedForSql\('s', '\$1'\)\}/);
  });

  it('a pod\'s live or imminent event is never someone else\'s draft or an archived event', () => {
    const pods = read('routes/pods.ts');
    const uses = pods.match(/AND \$\{eventListedForSql\('s', '\$2'\)\}/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(pods.match(/\[req\.params\.id, req\.user!\.userId\],/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Seeing, registering, entering ───────────────────────────────────────────

const facts = (over: Partial<EventAccessFacts> = {}): EventAccessFacts => ({
  visibility: null, podId: 'pod-1', podVisibility: 'public', isHost: false, isCohost: false, isPodOrganiser: false,
  inAudience: true, isInvited: false, participantStatus: null, accountActive: true, myRequest: null, outsideClosedCircle: false,
  publication: 'draft', archived: false, registrationOpensAt: null, viewerTimezone: null, isPodAdmin: false, placesHeld: 0,
  ...over,
});

describe('canSeeEvent on a draft', () => {
  it('only its host, a co-host or an admin', () => {
    expect(canSeeEvent(facts(), UserRole.MEMBER)).toBe(false);
    expect(canSeeEvent(facts({ visibility: 'public' }), UserRole.MEMBER)).toBe(false);
    expect(canSeeEvent(facts({ isPodOrganiser: true }), UserRole.MEMBER)).toBe(false);
    expect(canSeeEvent(facts({ isHost: true }), UserRole.MEMBER)).toBe(true);
    expect(canSeeEvent(facts({ isCohost: true }), UserRole.MEMBER)).toBe(true);
    expect(canSeeEvent(facts(), UserRole.ADMIN)).toBe(true);
    expect(canSeeEvent(facts({ publication: 'published' }), UserRole.MEMBER)).toBe(true);
  });
});

describe('registration that opens later', () => {
  const later = new Date(Date.now() + 86_400_000);
  it('holds back a member who may register, in words naming when (in their zone); never its organisers or invitees', () => {
    const f = facts({ publication: 'published', visibility: 'public', registrationOpensAt: later, viewerTimezone: 'Europe/Berlin' });
    const refused = canRegister(f, UserRole.MEMBER);
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'REGISTRATION_NOT_OPEN' });
    expect(!refused.ok && refused.message).toMatch(/^Registration for this event opens \w+day \d+ \w+, \d{2}:\d{2} \(CES?T\)\.$/);
    expect(canRegister({ ...f, isHost: true }, UserRole.MEMBER).ok).toBe(true);
    expect(canRegister({ ...f, isInvited: true }, UserRole.MEMBER).ok).toBe(true);
    expect(canRegister(f, UserRole.MEMBER, { viaInvite: true }).ok).toBe(true);
    expect(canRegister(f, UserRole.ADMIN).ok).toBe(true);
    expect(canRegister({ ...f, registrationOpensAt: new Date(Date.now() - 1000) }, UserRole.MEMBER).ok).toBe(true);
  });

  it('someone the event would refuse anyway hears that refusal, not the opening time', () => {
    const f = facts({ publication: 'published', visibility: 'private', inAudience: false, registrationOpensAt: later });
    expect(canRegister(f, UserRole.MEMBER)).toMatchObject({ ok: false, code: 'EVENT_PRIVATE' });
  });
});

/** canViewSession's and eventRoomAdmission's reads, for one event. */
function armEvent(event: { publication: string; host: string; cohost?: string; participant?: string | null; visibility?: string | null }) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const userId = params?.[1];
    if (sql.includes('pod_visibility') && sql.includes('account_closed')) {
      return { rows: [{
        host_user_id: event.host, pod_id: 'pod-1', pod_visibility: 'public', is_cohost: userId === event.cohost,
        visibility: event.visibility ?? null, account_closed: false, publication: event.publication,
      }] };
    }
    if (sql.includes('participant_status') && sql.includes('LEFT JOIN session_participants')) {
      return { rows: [{
        is_host: userId === event.host, is_cohost: userId === event.cohost, participant_status: event.participant ?? null,
        account_closed: false, publication: event.publication,
      }] };
    }
    return { rows: [] };
  });
}

describe('canViewSession and the live room on a draft', () => {
  it('the page: its host and co-host see it; a pod member of a public pod does not; an admin does', async () => {
    armEvent({ publication: 'draft', host: HOST, cohost: 'cohost-1' });
    expect(await canViewSession(HOST, EVENT, 'member')).toBe(true);
    expect(await canViewSession('cohost-1', EVENT, 'member')).toBe(true);
    expect(await canViewSession(MEMBER, EVENT, 'member')).toBe(false);
    expect(await canViewSession(MEMBER, EVENT, 'admin')).toBe(true);
  });

  it('the live room refuses anyone who does not run it, even with a participant row; the host is let in', async () => {
    armEvent({ publication: 'draft', host: HOST, participant: 'registered' });
    expect(await eventRoomAdmission(EVENT, MEMBER, 'member')).toBe('refused');
    expect(await eventRoomAdmission(EVENT, HOST, 'member')).toBe('admitted');
    expect(await eventRoomAdmission(EVENT, MEMBER, 'admin')).toBe('admitted');
    armEvent({ publication: 'published', host: HOST, participant: 'registered' });
    expect(await eventRoomAdmission(EVENT, MEMBER, 'member')).toBe('admitted');
  });
});

describe('registerParticipant on a draft', () => {
  function armRegistration(publication: string, viewer: { isHost: boolean }) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM sessions WHERE id = $1') && sql.includes('"registrationOpensAt"')) {
        return { rows: [{ id: EVENT, podId: 'pod-1', status: 'scheduled', publication, registrationOpensAt: null, visibility: null, hostUserId: HOST, config: {} }] };
      }
      if (sql.includes('event_join_requests')) {
        return { rows: [{ visibility: null, pod_id: 'pod-1', pod_visibility: 'public', is_host: viewer.isHost, is_cohost: false,
          is_pod_organiser: false, in_audience: true, is_invited: false, participant_status: null, account_active: true,
          my_request: null, outside_closed_circle: false, publication, archived: false }] };
      }
      throw new Error(`stop here: ${flat(sql).slice(0, 60)}`);
    });
  }

  it('a member is answered 404 with the words an unknown id gets, before anything is written', async () => {
    armRegistration('draft', { isHost: false });
    await expect(registerParticipant(EVENT, MEMBER, UserRole.MEMBER)).rejects.toMatchObject({
      statusCode: 404, message: "We couldn't find that event.",
    });
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });

  it('its host goes on to the usual checks', async () => {
    armRegistration('draft', { isHost: true });
    await expect(registerParticipant(EVENT, HOST, UserRole.MEMBER)).rejects.toThrow(/stop here: SELECT visibility FROM pods/);
  });

  it('a published event with no opening time reads nothing more than before', async () => {
    armRegistration('published', { isHost: false });
    await expect(registerParticipant(EVENT, MEMBER, UserRole.MEMBER)).rejects.toThrow(/stop here: SELECT visibility FROM pods/);
    expect(mockQuery.mock.calls.some(([sql]) => sql.includes('event_join_requests'))).toBe(false);
  });
});

// ── GET /sessions/:id ───────────────────────────────────────────────────────

function app() {
  const a = express();
  a.use(express.json());
  a.use('/sessions', sessionRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.org`, role, sessionId: 'sess-1' }, JWT_SECRET, { expiresIn: '15m' });

/** The event row as production reads it today, before migration 135 is used: published, never archived, no opening time. */
const productionRow = {
  id: EVENT, podId: 'pod-1', title: 'Founders breakfast', description: null, scheduledAt: '2026-11-20T08:00:00.000Z',
  startedAt: null, endedAt: null, status: 'scheduled', currentRound: 0, config: { numberOfRounds: 5 },
  hostUserId: HOST, lobbyRoomId: null, hostVisibilityMode: 'normal', format: 'speed_networking', visibility: null,
  circleId: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const LIFECYCLE_COLUMNS = {
  publication: 'published', publishedAt: null, registrationOpensAt: null, archivedAt: null, cancelledAt: null, cancelReason: null,
};

function armRoute(world: { exists: boolean; publication?: string; viewerIsHost?: boolean }) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT status FROM users') || sql.includes('FROM users WHERE id = $1') && sql.includes('status')) {
      return { rows: [{ status: 'active' }] };
    }
    if (!world.exists) return { rows: [] };
    if (sql.includes('pod_visibility') && sql.includes('account_closed') && !sql.includes('event_join_requests')) {
      return { rows: [{ host_user_id: HOST, pod_id: 'pod-1', pod_visibility: 'public', is_cohost: false, visibility: null,
        account_closed: false, publication: world.publication ?? 'published' }] };
    }
    if (sql.startsWith('SELECT visibility, (publication')) return { rows: [{ visibility: null, is_draft: world.publication === 'draft' }] };
    if (sql.includes('session_participants') && sql.includes('LIMIT 1') && sql.startsWith('SELECT status')) {
      return { rows: [{ status: 'registered' }] };
    }
    if (sql.includes('event_join_requests')) {
      return { rows: [{ visibility: null, pod_id: 'pod-1', pod_visibility: 'public', is_host: params?.[1] === HOST, is_cohost: false,
        is_pod_organiser: false, in_audience: true, is_invited: false, participant_status: 'registered', account_active: true,
        my_request: null, outside_closed_circle: false, publication: world.publication ?? 'published', archived: false,
        registration_opens_at: null, viewer_timezone: null, is_pod_admin: false, places_held: 2 }] };
    }
    if (sql.includes('"registrationOpensAt"') && sql.includes('WHERE id = $1')) {
      return { rows: [{ ...productionRow, ...LIFECYCLE_COLUMNS, publication: world.publication ?? 'published' }] };
    }
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '3' }] };
    return { rows: [] };
  });
}

describe('GET /sessions/:id', () => {
  it('a draft, to a member, is the same 404 as an id that names no event', async () => {
    armRoute({ exists: true, publication: 'draft' });
    const draft = await request(app()).get(`/sessions/${EVENT}`).set('Authorization', `Bearer ${token(MEMBER)}`);
    armRoute({ exists: false });
    const unknown = await request(app()).get(`/sessions/${RANDOM}`).set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(draft.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(draft.body).toEqual(unknown.body);
    expect(draft.body.error).toMatchObject({ code: 'SESSION_NOT_FOUND', message: "We couldn't find that event." });
  });

  it('its host reads it with its lifecycle and the steps they may take', async () => {
    armRoute({ exists: true, publication: 'draft' });
    const res = await request(app()).get(`/sessions/${EVENT}`).set('Authorization', `Bearer ${token(HOST)}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ publication: 'draft', lifecycle: 'draft', allowedActions: ['publish', 'cancel'] });
  });

  it('a production-shaped event answers exactly as before, plus the additive fields', async () => {
    armRoute({ exists: true });
    const res = await request(app()).get(`/sessions/${EVENT}`).set('Authorization', `Bearer ${token(MEMBER)}`);
    expect(res.status).toBe(200);
    const { lifecycle, allowedActions, publication, publishedAt, registrationOpensAt, archivedAt, cancelledAt, cancelReason, ...before } = res.body.data;
    expect({ lifecycle, allowedActions }).toEqual({ lifecycle: 'registration_open', allowedActions: [] });
    expect({ publication, publishedAt, registrationOpensAt, archivedAt, cancelledAt, cancelReason }).toEqual(LIFECYCLE_COLUMNS);
    expect(before).toEqual({
      ...productionRow,
      participantCount: 3,
      access: { visibility: null, mode: 'register', myRequest: null, autoRegister: true, canManageRequests: false },
    });
  });
});

// ── Deleting for good keeps the snapshot ────────────────────────────────────

describe('hardDeleteSession with an audit', () => {
  it('writes event.deleted with what the event was, in the same transaction and before the deletes', async () => {
    const order: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      order.push(flat(sql).slice(0, 40));
      if (sql.includes('"registrationOpensAt"')) return { rows: [{ ...productionRow, ...LIFECYCLE_COLUMNS }] };
      if (sql.includes('FOR UPDATE OF s')) {
        return { rows: [{ title: 'Founders breakfast', scheduled_at: new Date('2026-11-20T08:00:00.000Z'), host_user_id: HOST,
          pod_id: 'pod-1', status: 'completed', participant_user_ids: [HOST, MEMBER] }] };
      }
      return { rows: [], rowCount: 1 };
    });
    mockAudit.mockImplementation(async () => { order.push('AUDIT'); });
    await hardDeleteSession(EVENT, { actorId: 'super-1' });
    expect(mockAudit).toHaveBeenCalledWith({
      sessionId: EVENT, actorId: 'super-1', action: 'event.deleted', automatic: false, subjectUserIds: [HOST, MEMBER],
      before: {
        title: 'Founders breakfast', scheduledAt: '2026-11-20T08:00:00.000Z', hostUserId: HOST, podId: 'pod-1',
        participantUserIds: [HOST, MEMBER], status: 'completed',
      },
    }, mockClient);
    const audit = order.indexOf('AUDIT');
    const firstDelete = order.findIndex((s) => s.startsWith('DELETE'));
    expect(audit).toBeGreaterThan(-1);
    expect(audit).toBeLessThan(firstDelete);
    expect(order.some((s) => s.startsWith('DELETE FROM sessions'))).toBe(true);
  });

  it('refuses a live event when asked to (the lifecycle\'s delete), deleting nothing', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('"registrationOpensAt"')) return { rows: [{ ...productionRow, ...LIFECYCLE_COLUMNS }] };
      if (sql.includes('FOR UPDATE OF s')) {
        return { rows: [{ title: 'x', scheduled_at: null, host_user_id: HOST, pod_id: null, status: 'round_active', participant_user_ids: [] }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(hardDeleteSession(EVENT, { actorId: 'super-1', refuseWhileLive: true })).rejects.toMatchObject({
      statusCode: 409, code: 'SESSION_IN_PROGRESS',
    });
    expect(mockQuery.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
  });

  it('without an audit (an older caller) it deletes as before and writes no row', async () => {
    mockQuery.mockImplementation(async (sql: string) =>
      (sql.includes('"registrationOpensAt"') ? { rows: [{ ...productionRow, ...LIFECYCLE_COLUMNS }] } : { rows: [], rowCount: 1 }));
    await hardDeleteSession(EVENT);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

// ── Go Live on a draft ──────────────────────────────────────────────────────

describe('starting a draft', () => {
  const host = read('services/orchestration/handlers/host-actions.ts');
  const body = (start: string) => host.slice(host.indexOf(start), host.indexOf('\n}\n', host.indexOf(start)));

  it('the socket start refuses it in words before anything opens', () => {
    const fn = body('export async function handleHostStart(');
    const refusal = fn.indexOf("if (session.publication === 'draft') {");
    expect(refusal).toBeGreaterThan(-1);
    expect(fn.indexOf("socket.emit('error', { code: ErrorCodes.EVENT_NOT_PUBLISHED, message: EVENT_DRAFT_START_REFUSAL });")).toBeGreaterThan(refusal);
    expect(refusal).toBeLessThan(fn.indexOf('await openEventLobby('));
    expect(host).toContain("export const EVENT_DRAFT_START_REFUSAL = 'Publish the event before starting it.';");
  });

  it('the REST start refuses it too', () => {
    const fn = body('async function startSessionGuarded(');
    const refusal = fn.indexOf("if (session.publication === 'draft') throw new ConflictError(ErrorCodes.EVENT_NOT_PUBLISHED, EVENT_DRAFT_START_REFUSAL);");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(fn.indexOf('await openEventLobby('));
  });
});
