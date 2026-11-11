// ─── A waiting person opens the event page, and only the page (Part 3 Task 3, controller ruling after the prod smoke) ──
//
// Someone on a full event's waiting list (and nothing else: not its audience, no place, not invited) may open
// GET /sessions/:id to see their place in the line and leave it. They may NOT read the live state (GET /:id/state: the
// roster, ids and names, once it is live) nor the attendee list (GET /:id/participants): each answers exactly as it
// answers someone with no tie to the event. Checked on both kinds of event: one with its own private visibility (an
// open-admission event in a pod, link-only: the smoke's case) and one that follows a private pod (visibility NULL).

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => {
  const config = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', clientUrl: 'http://localhost:5173',
    apiBaseUrl: 'http://localhost:3001', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test',
    isDev: false, isProd: false, isTest: true,
  };
  return { config, default: config, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
type Answer = { rows: unknown[]; rowCount?: number };
const mockQuery = jest.fn<Promise<Answer>, [string, unknown[]?]>();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) }),
  __esModule: true,
}));
const mockSnapshot = jest.fn();
jest.mock('../../services/session/session-state-snapshot.service', () => ({
  buildSessionStateSnapshot: (...a: unknown[]) => mockSnapshot(...a),
  __esModule: true,
}));

import sessionRoutes from '../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const EVENT = '5e550000-0000-4000-8000-0000000000d1';
const HOST = '05e70000-0000-4000-8000-0000000000a1';
const WAITER = '05e70000-0000-4000-8000-0000000000b2';
const STRANGER = '05e70000-0000-4000-8000-0000000000c3';

const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/sessions', sessionRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@rsn-e2e.invalid`, role: 'member', sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });
const get = (path: string, who: string) => request(app()).get(`/sessions/${EVENT}${path}`).set('Authorization', `Bearer ${token(who)}`);

/** The event as the routes read it: full (2 of 2), WAITER first in line; nobody else has any tie to it. */
function arm(visibility: 'private' | null) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const who = params?.[1];
    const waiting = who === WAITER;
    if (sql.includes('SELECT status, account_kind FROM users')) return { rows: [{ status: 'active', account_kind: 'member' }] };
    // canViewSession's first read.
    if (sql.includes('pod_visibility') && sql.includes('account_closed') && !sql.includes('event_join_requests')) {
      return { rows: [{ host_user_id: HOST, pod_id: 'pod-1', pod_visibility: 'private', is_cohost: false, visibility,
        account_closed: false, publication: 'published' }] };
    }
    // readEventAccessFacts.
    if (sql.includes('event_join_requests') && sql.includes('AS waitlist_position')) {
      return { rows: [{ visibility, pod_id: 'pod-1', pod_visibility: 'private', is_host: who === HOST, is_cohost: false,
        is_pod_organiser: false, in_audience: false, is_invited: false, participant_status: null, account_active: true,
        my_request: null, outside_closed_circle: false, publication: 'published', archived: false, registration_opens_at: null,
        event_timezone: 'UTC', is_pod_admin: false, places_held: 2, admission_mode: visibility ? 'open' : null,
        capacity: 2, places_taken: 2, waitlist_position: waiting ? 1 : null, waitlist_ahead: waiting ? 0 : 1,
        event_status: 'scheduled' }] };
    }
    // canViewSession's NULL-event steps: no place, no pod membership, and the waiting row (only for the page).
    if (sql.startsWith('SELECT 1 AS waiting FROM event_waitlist')) return { rows: waiting ? [{ waiting: 1 }] : [] };
    if (sql.startsWith('SELECT visibility, (publication')) return { rows: [{ visibility, is_draft: false }] };
    if (sql.startsWith("SELECT (publication = 'draft') AS is_draft")) return { rows: [{ is_draft: false }] };
    if (sql.includes('"registrationOpensAt"') && sql.includes('WHERE id = $1')) {
      return { rows: [{ id: EVENT, podId: 'pod-1', title: 'Full breakfast', status: 'scheduled', hostUserId: HOST, visibility,
        publication: 'published', config: { maxParticipants: 2 }, timezone: 'UTC', hasImage: false, imageUpdatedAt: null }] };
    }
    if (sql.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSnapshot.mockReset().mockResolvedValue({ hostUserId: HOST, cohosts: [], participants: [{ userId: 'u-1', displayName: 'Ana' }] });
});

describe.each([
  ['an event with its own private visibility (open admission, link-only)', 'private' as const],
  ['an event that follows a private pod (no visibility of its own)', null],
])('%s, full, with someone on its waiting list', (_label, visibility) => {
  it('GET /sessions/:id: 200 for the waiting person, with their place in the line', async () => {
    arm(visibility);
    const res = await get('', WAITER);
    expect(res.status).toBe(200);
    expect(res.body.data.access.waitlist).toEqual({ full: true, position: 1 });
  });

  it('GET /sessions/:id/state: refused exactly as a stranger is, and the live state is never built for them', async () => {
    arm(visibility);
    const waiter = await get('/state', WAITER);
    const stranger = await get('/state', STRANGER);
    expect(waiter.status).toBe(403);
    expect(waiter.status).toBe(stranger.status);
    expect(waiter.body).toEqual(stranger.body);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('GET /sessions/:id/participants: refused exactly as a stranger is', async () => {
    arm(visibility);
    const waiter = await get('/participants', WAITER);
    const stranger = await get('/participants', STRANGER);
    expect(waiter.status).toBe(403);
    expect(waiter.body).toEqual(stranger.body);
  });

  it('a stranger (not waiting) is refused the page too, as before', async () => {
    arm(visibility);
    const res = await get('', STRANGER);
    expect(res.status).toBe(403);
  });
});
