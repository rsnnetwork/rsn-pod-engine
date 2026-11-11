// ─── Capacity: who holds a place, and what a full event answers (10 Nov 2026 spec, Part 3 Task 3; plan K3) ────────
//
// A place is held by any participant row that is not removed, of an active account, other than the host's and the
// co-hosts' (capacityTakenSql). left, disconnected and no_show keep their place. A removal is answered as a removal on
// a full event, never as "full", and never queued. The people who run the event are never held to capacity. The event
// page's register route answers a full event exactly as before (409 SESSION_FULL, same body) unless it asks for the
// waiting list (`waitlist: true`: 202 with the position). The real registration and route run against the in-memory
// world (fixtures/waitlist-world.ts).

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', clientUrl: 'https://app.rsn.network',
    apiBaseUrl: 'https://api.rsn.network', rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000, env: 'test',
    isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/waitlist-world');
  return { query: w.run, transaction: w.inTransaction, __esModule: true };
});
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true,
}));
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: jest.fn().mockResolvedValue(undefined),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  resolveSessionListAudience: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));
const mockRegistrationEmail = jest.fn();
jest.mock('../../../services/session/registration-email', () => ({
  sendRegistrationEmail: (...a: unknown[]) => mockRegistrationEmail(...a), __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: async () => [], __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: async () => ({ allowed: false, effectiveRole: 'participant' }), __esModule: true,
}));

import { ErrorCodes, UserRole } from '@rsn/shared';
import {
  addEvent, addPlace, addUser, lineOf, placeOf, resetWaitlistWorld, wid, world,
} from '../../fixtures/waitlist-world';
import { registerParticipant } from '../../../services/session/session.service';
import { registerOrWaitlist } from '../../../services/session/event-waitlist.service';
import sessionRoutes from '../../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

let n = 200;
const fresh = () => addUser({ id: wid(++n) }).id;
const FULL = { status: 409, code: 'SESSION_FULL', message: 'This event has reached its maximum participant count' };

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try { await p; return 'ok'; } catch (e) { const err = e as { statusCode?: number; code?: string; message?: string }; return { status: err.statusCode, code: err.code, message: err.message }; }
}
const lockTaken = (from: number) => world.sql.slice(from).some((s) => s.includes('pg_advisory_xact_lock'));

let HOST: string;
let EVENT: string;
beforeEach(() => {
  resetWaitlistWorld();
  HOST = fresh();
  EVENT = wid(++n);
  addEvent({ id: EVENT, host_user_id: HOST, config: { maxParticipants: 2 } });
});

describe('who holds a place', () => {
  it('the host and the co-hosts never count: two members fill an event of two while both are registered', async () => {
    const cohost = fresh();
    addPlace(EVENT, cohost);
    world.rows.cohosts.push({ session_id: EVENT, user_id: cohost });
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    expect(await refusal(registerParticipant(EVENT, fresh(), UserRole.MEMBER))).toEqual(FULL);
  });

  it('left and no_show keep their place: a newcomer is refused, and they come back with no capacity count and no lock', async () => {
    const leaver = fresh();
    const noShow = fresh();
    addPlace(EVENT, leaver, 'left');
    addPlace(EVENT, noShow, 'no_show');
    expect(await refusal(registerParticipant(EVENT, fresh(), UserRole.MEMBER))).toEqual(FULL);
    for (const person of [leaver, noShow]) {
      const from = world.sql.length;
      await expect(registerParticipant(EVENT, person, UserRole.MEMBER)).resolves.toMatchObject({ status: 'registered', isNewRegistration: false });
      expect(lockTaken(from)).toBe(false);
    }
  });

  it('a suspended or closed account holds no place', async () => {
    const away = fresh();
    addPlace(EVENT, away);
    world.rows.users.find((u) => u.id === away)!.status = 'suspended';
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    await expect(registerParticipant(EVENT, fresh(), UserRole.MEMBER)).resolves.toMatchObject({ isNewRegistration: true });
  });

  it('a removed person on a full event hears REMOVED_FROM_EVENT, never SESSION_FULL, and is never queued', async () => {
    const kicked = fresh();
    addPlace(EVENT, kicked, 'removed');
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    expect(await refusal(registerParticipant(EVENT, kicked, UserRole.MEMBER))).toMatchObject({ status: 403, code: 'REMOVED_FROM_EVENT' });
    expect(await refusal(registerOrWaitlist(EVENT, kicked, UserRole.MEMBER, { joinedVia: 'register' }))).toMatchObject({ status: 403, code: 'REMOVED_FROM_EVENT' });
    expect(lineOf(EVENT, kicked)).toBeUndefined();
  });

  it('an admin (who runs every event) registers over capacity and is never queued', async () => {
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    const admin = fresh();
    await expect(registerOrWaitlist(EVENT, admin, UserRole.ADMIN, { joinedVia: 'register' })).resolves.toMatchObject({ kind: 'registered' });
    expect(placeOf(EVENT, admin)?.status).toBe('registered');
  });

  it('an event with no limit (an old config without the key) takes everyone, as before', async () => {
    world.rows.events[0].config = {};
    for (let i = 0; i < 5; i += 1) await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    expect(world.rows.places.filter((p) => p.session_id === EVENT)).toHaveLength(6);
  });
});

describe('POST /sessions/:id/register on a full event', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/sessions', sessionRoutes);
    a.use(notFoundHandler);
    a.use(errorHandler);
    return a;
  };
  const token = (sub: string) => jwt.sign({ sub, email: `${sub}@rsn-e2e.invalid`, role: 'member', sessionId: 's' }, 'test-jwt-secret', { expiresIn: '15m' });
  const post = (who: string, body?: object) => {
    const r = request(app()).post(`/sessions/${EVENT}/register`).set('Authorization', `Bearer ${token(who)}`);
    return body ? r.send(body) : r;
  };

  beforeEach(async () => {
    mockRegistrationEmail.mockReset();
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
    await registerParticipant(EVENT, fresh(), UserRole.MEMBER);
  });

  it('without `waitlist` answers 409 SESSION_FULL with exactly today\'s body, and queues nobody', async () => {
    const who = fresh();
    for (const body of [undefined, {}, { waitlist: false }]) {
      const res = await post(who, body);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ success: false, error: { code: 'SESSION_FULL', message: 'This event has reached its maximum participant count' } });
    }
    expect(lineOf(EVENT, who)).toBeUndefined();
  });

  it('with `waitlist: true` answers 202 { waitlisted: true, position: 1 }; the same call again gives the same position', async () => {
    const who = fresh();
    const first = await post(who, { waitlist: true });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ success: true, data: { waitlisted: true, position: 1 } });
    const again = await post(who, { waitlist: true });
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ success: true, data: { waitlisted: true, position: 1 } });
    const next = await post(fresh(), { waitlist: true });
    expect(next.body.data).toEqual({ waitlisted: true, position: 2 });
    expect(mockRegistrationEmail).not.toHaveBeenCalled();
  });

  it('with `waitlist: true` on an event with room registers as before: 201 and the "you\'re registered" email', async () => {
    world.rows.events[0].config = { maxParticipants: 3 };
    const who = fresh();
    const res = await post(who, { waitlist: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userId: who, status: 'registered', isNewRegistration: true });
    expect(mockRegistrationEmail).toHaveBeenCalledWith(EVENT, who);
  });

  it('refuses a `waitlist` that is not true or false', async () => {
    const res = await post(fresh(), { waitlist: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });
});
