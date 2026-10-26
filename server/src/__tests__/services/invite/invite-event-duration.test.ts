// ─── An invite's calendar entry is as long as the event (26 Oct 2026) ────────────────────────────
//
// Four formulas computed an event's length, all from rounds; the two reminder routes even left out the rating
// windows and the closing lobby. A 90-minute video meeting went into calendars as a 47-minute block of five
// rounds. Every invite email now takes its length from the shared eventDurationMinutes: a meeting's own length,
// and for speed networking the same rounds formula the first invite and the registration email use.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm',
    magicLinkExpiryMinutes: 15, clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  // The duplicate check and the insert of a personal invite run in a transaction (26 Oct 2026): its client asks the same database.
  transaction: async (callback: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    callback({ query: (...args: unknown[]) => mockQuery(...args) }),
  __esModule: true,
}));

const mockSendInviteEmail = jest.fn(async () => undefined);
jest.mock('../../../services/email/email.service', () => ({
  sendInviteEmail: (...args: unknown[]) => (mockSendInviteEmail as jest.Mock)(...args),
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));

import { InviteType, DEFAULT_SESSION_CONFIG } from '@rsn/shared';
import { createInvite } from '../../../services/invite/invite.service';
import inviteRoutes from '../../../routes/invites';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

const SESSION_ID = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const HOST = 'user-host';
const WHEN = '2026-11-01T12:00:00.000Z';

const MEETING_ROW = {
  title: 'Video meeting · Test', scheduled_at: WHEN, host_user_id: HOST,
  config: { durationMinutes: 90, maxParticipants: 8, eventType: 'video_meeting' }, event_format: 'video_meeting',
};
const SPEED_ROW = {
  title: 'Speed networking · Test', scheduled_at: WHEN, host_user_id: HOST,
  config: { ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' }, event_format: 'speed_networking',
};

const POD_ID = '6d2e8a14-7c3b-4e1f-9a5d-0b8c7e6f4a31';

/** The invite a reminder is asked for: an event's unless a test says otherwise. */
let remindedInvite: Record<string, unknown>;
const eventInviteRow = () => ({
  id: 'inv-1', invitee_email: 'guest@example.com', type: 'session', session_id: SESSION_ID, pod_id: null, circle_id: null,
  inviter_id: HOST, status: 'pending', code: 'CODE1', expires_at: null,
});

/** A database that answers by what the SQL asks for. */
function world(eventRow: Record<string, unknown>) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT status FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active' }] };
    if (/FROM invites WHERE id = \$1/.test(sql)) return { rows: [remindedInvite] };
    if (/SELECT role FROM pod_members WHERE pod_id = \$1/.test(sql)) return { rows: [{ role: 'director' }] };
    if (/SELECT name FROM pods WHERE id = \$1/.test(sql)) return { rows: [{ name: 'Reason circle' }] };
    if (/FROM invites\s+WHERE session_id = \$1 AND status = 'pending'/.test(sql)) {
      return { rows: [{ id: 'inv-1', invitee_email: 'guest@example.com', code: 'CODE1' }] };
    }
    if (/SELECT host_user_id FROM sessions/.test(sql)) return { rows: [{ host_user_id: HOST }] };
    // Who runs the event's invites (the host here): the reminders ask it since a co-host may remind too.
    if (/AS is_host/.test(sql)) return { rows: [{ is_host: true, is_cohost: false }] };
    if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [eventRow] };
    if (/INSERT INTO invites/.test(sql)) return { rows: [{ id: 'inv-1', code: 'CODE1' }] };
    if (/display_name/.test(sql)) return { rows: [{ displayName: 'Claus', display_name: 'Claus', email: 'c@example.com' }] };
    return { rows: [] };
  });
}

function sentDuration(): number {
  expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
  return (mockSendInviteEmail as jest.Mock).mock.calls[0][1].calendarEvent.durationMinutes;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/invites', inviteRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

const token = jwt.sign({ sub: HOST, email: 'h@example.com', role: 'member', sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });

beforeEach(() => {
  mockQuery.mockReset();
  remindedInvite = eventInviteRow();
  mockSendInviteEmail.mockClear();
  mockGetSessionById.mockResolvedValue({ id: SESSION_ID, status: 'scheduled', hostUserId: HOST });
});

describe('the first invite email', () => {
  it('puts a 90-minute meeting in the calendar for 90 minutes', async () => {
    world(MEETING_ROW);
    await createInvite(HOST, { type: InviteType.SESSION, sessionId: SESSION_ID, inviteeEmail: 'guest@example.com' }, 'admin');
    expect(sentDuration()).toBe(90);
  });

  it('keeps the speed-networking length it always had: 53 minutes for a new event', async () => {
    world(SPEED_ROW);
    await createInvite(HOST, { type: InviteType.SESSION, sessionId: SESSION_ID, inviteeEmail: 'guest@example.com' }, 'admin');
    // 5×480 + 5×30 + 4×30 + 480 (closing lobby) = 3150 s, rounded up.
    expect(sentDuration()).toBe(53);
  });
});

describe('the reminder emails', () => {
  it('POST /invites/:id/remind uses the meeting length', async () => {
    world(MEETING_ROW);
    const res = await request(app()).post('/invites/inv-1/remind').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(sentDuration()).toBe(90);
  });

  it('POST /invites/remind-all/:sessionId uses the meeting length', async () => {
    world(MEETING_ROW);
    const res = await request(app()).post(`/invites/remind-all/${SESSION_ID}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(sentDuration()).toBe(90);
  });

  it('a speed-networking reminder is as long as its first invite (the rating windows and closing lobby count)', async () => {
    world(SPEED_ROW);
    await request(app()).post('/invites/inv-1/remind').set('Authorization', `Bearer ${token}`);
    // 53 minutes, as the first invite; the reminder's old formula left out ratings and the closing lobby (42).
    expect(sentDuration()).toBe(53);
  });
});

// Fix round 2: every reminder used to be written as an event invite ("has invited you to join an event"), with no name at
// all for a pod, a circle or the platform. It is now built by the same functions as the first invite, so each kind is
// reminded in its own words. These run the real route and the real service.
describe('the reminder says what the invite was for', () => {
  const remind = () => request(app()).post('/invites/inv-1/remind').set('Authorization', `Bearer ${token}`);
  const sent = () => {
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    return (mockSendInviteEmail as jest.Mock).mock.calls[0][1];
  };

  it('a pod invite is reminded as a pod invite, with the pod\'s name, that invite\'s link, and no calendar entry', async () => {
    world(MEETING_ROW);
    remindedInvite = { ...eventInviteRow(), type: 'pod', session_id: null, pod_id: POD_ID };
    const res = await remind();
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ type: 'pod', targetName: 'Reason circle', inviterName: 'Claus', inviteUrl: 'http://localhost:5173/invite/CODE1' });
    expect(sent().calendarEvent).toBeUndefined();
  });

  it('the words the member reads for it are a pod\'s: "join a pod — Reason circle", not an event', async () => {
    world(MEETING_ROW);
    remindedInvite = { ...eventInviteRow(), type: 'pod', session_id: null, pod_id: POD_ID };
    await remind();
    const { buildInviteEmail } = jest.requireActual('../../../services/email/email.service') as typeof import('../../../services/email/email.service');
    const { subject, text } = buildInviteEmail(sent());
    expect(subject).toBe('Claus invited you to Reason circle');
    expect(text).toContain('has invited you to join a pod — Reason circle on REASON.');
    expect(text).not.toMatch(/an event/);
  });

  it('an event invite is still reminded as an event invite, with its title and its calendar entry', async () => {
    world(MEETING_ROW);
    await remind();
    expect(sent()).toMatchObject({ type: 'session', targetName: 'Video meeting · Test' });
    expect(sent().calendarEvent).toMatchObject({ durationMinutes: 90, sessionId: SESSION_ID });
  });
});
