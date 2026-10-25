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
  transaction: jest.fn(),
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
import { computeSessionDurationMinutes } from '../../../services/calendar/calendar.service';

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

/** A database that answers by what the SQL asks for. */
function world(eventRow: Record<string, unknown>) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT status FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active' }] };
    if (/FROM invites WHERE id = \$1/.test(sql)) {
      return { rows: [{ id: 'inv-1', invitee_email: 'guest@example.com', session_id: SESSION_ID, pod_id: null, status: 'pending', code: 'CODE1' }] };
    }
    if (/FROM invites\s+WHERE session_id = \$1 AND status = 'pending'/.test(sql)) {
      return { rows: [{ id: 'inv-1', invitee_email: 'guest@example.com', code: 'CODE1' }] };
    }
    if (/SELECT host_user_id FROM sessions/.test(sql)) return { rows: [{ host_user_id: HOST }] };
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
  mockSendInviteEmail.mockClear();
  mockGetSessionById.mockResolvedValue({ id: SESSION_ID, status: 'scheduled', hostUserId: HOST });
});

describe('the first invite email', () => {
  it('puts a 90-minute meeting in the calendar for 90 minutes', async () => {
    world(MEETING_ROW);
    await createInvite(HOST, { type: InviteType.SESSION, sessionId: SESSION_ID, inviteeEmail: 'guest@example.com' }, 'admin');
    expect(sentDuration()).toBe(90);
  });

  it('keeps the speed-networking length it always had', async () => {
    world(SPEED_ROW);
    await createInvite(HOST, { type: InviteType.SESSION, sessionId: SESSION_ID, inviteeEmail: 'guest@example.com' }, 'admin');
    expect(sentDuration()).toBe(computeSessionDurationMinutes(SPEED_ROW.config));
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
    expect(sentDuration()).toBe(computeSessionDurationMinutes(SPEED_ROW.config));
  });
});
