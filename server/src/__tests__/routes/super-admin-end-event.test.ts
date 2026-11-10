// ─── A super admin can end any event (10 Nov 2026, F7, spec 10/07) ─────────────────────────────────────────────
//
// POST /sessions/:id/host/end let a super admin past the route's gate (verifyHostOrSuperAdmin), then endSession
// refused everyone but the host, so Stefan could not end a member's event that was left running. Now:
//   - the host ends their own event, as before;
//   - a super admin ends any event, through the same completion the socket End Event runs (under the session guard),
//     whose own fan-out (fanoutSessionCompleted) tells the admins' event list;
//   - an admin (or a member) who is not the host is refused, at the route and in endSession itself.
// The role is the caller's platform role from their token, never their attendance: a super admin who is also a
// participant of the event is still a super admin, and an admin registered for it is still refused.
//
// Inside the live room (spec 12/14, fix round 1): the socket End Event (host:end_session, endEvent:true) is accepted
// from a super admin who is in the room as a participant (their acting-as-host override is false, so verifyHost reads
// them as a participant). Ending a round still needs host rights; a plain admin and a co-host are unchanged.

import express from 'express';
import request from 'supertest';
import { UserRole, SessionStatus } from '@rsn/shared';

const HOST = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUPER = 'bbbbbbbb-0000-4000-8000-000000000002';
const ADMIN = 'cccccccc-0000-4000-8000-000000000003';
const MEMBER = 'dddddddd-0000-4000-8000-000000000004';
const EVENT = 'eeeeeeee-0000-4000-8000-000000000005';

const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), fatal: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { userId: req.headers['x-as'], email: 'x@example.com', role: req.headers['x-role'], sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  updateSessionStatus: jest.fn(),
  updateParticipantStatus: jest.fn(),
  getSessionParticipants: jest.fn().mockResolvedValue([]),
  incrementRoundsCompleted: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/matching/matching.service', () => ({ createMatchesForRound: jest.fn().mockResolvedValue([]), __esModule: true }));
jest.mock('../../services/rating/rating.service', () => ({
  finalizeRoundRatings: jest.fn().mockResolvedValue({ totalMatches: 0, ratedMatches: 0, mutualConnections: 0 }),
  __esModule: true,
}));

const COHOST = 'ffffffff-0000-4000-8000-000000000006';

import hostRoutes from '../../routes/host';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as orchestrationService from '../../services/orchestration/orchestration.service';
import { injectHostActionDeps, setHostActionsIo, handleHostEnd } from '../../services/orchestration/handlers/host-actions';
import { ForbiddenError } from '../../middleware/errors';

const app = express();
app.use(express.json());
app.use('/sessions', hostRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const fakeIo = { to: () => ({ emit: jest.fn() }) } as unknown as Parameters<typeof setHostActionsIo>[0];
const mockComplete = jest.fn();

beforeAll(() => {
  setHostActionsIo(fakeIo);
  injectHostActionDeps({
    transitionToRound: jest.fn(),
    completeSession: (...args: Parameters<typeof mockComplete>) => mockComplete(...args),
    endRound: jest.fn(),
    endRatingWindow: jest.fn(),
    emitHostDashboard: jest.fn(),
    timerCallbacks: {} as Parameters<typeof injectHostActionDeps>[0]['timerCallbacks'],
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
  mockComplete.mockResolvedValue(undefined);
  // A member's event, live: its host is HOST.
  mockGetSessionById.mockResolvedValue({ id: EVENT, hostUserId: HOST, status: SessionStatus.ROUND_ACTIVE });
});

const end = (userId: string, role: UserRole) =>
  request(app).post(`/sessions/${EVENT}/host/end`).set('x-as', userId).set('x-role', role);

describe('POST /sessions/:id/host/end', () => {
  it('a super admin ends a member-hosted event: the completion runs once (its own fan-out tells the admins\' list)', async () => {
    const res = await end(SUPER, UserRole.SUPER_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
  });

  it('the host still ends their own event', async () => {
    const res = await end(HOST, UserRole.MEMBER);
    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
  });

  it('an admin who is not the host is refused and nothing completes', async () => {
    const res = await end(ADMIN, UserRole.ADMIN);
    expect(res.status).toBe(403);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('a member who is not the host is refused and nothing completes', async () => {
    const res = await end(MEMBER, UserRole.MEMBER);
    expect(res.status).toBe(403);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('pressed twice, both answer (the completion\'s own database claim ends the event once)', async () => {
    const [a, b] = await Promise.all([end(SUPER, UserRole.SUPER_ADMIN), end(SUPER, UserRole.SUPER_ADMIN)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });
});

describe('endSession(sessionId, actor)', () => {
  it('a super admin who is not the host calls the completion', async () => {
    await orchestrationService.endSession(EVENT, { userId: SUPER, role: UserRole.SUPER_ADMIN });
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
  });

  it('an admin who is not the host gets ForbiddenError (the role, not attendance, decides)', async () => {
    await expect(orchestrationService.endSession(EVENT, { userId: ADMIN, role: UserRole.ADMIN }))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('the host, whatever their platform role, ends it', async () => {
    await orchestrationService.endSession(EVENT, { userId: HOST, role: UserRole.MEMBER });
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
  });

  it('an event that does not exist is not found, and nothing completes', async () => {
    mockGetSessionById.mockRejectedValueOnce(Object.assign(new Error('Event not found'), { statusCode: 404 }));
    await expect(orchestrationService.endSession(EVENT, { userId: SUPER, role: UserRole.SUPER_ADMIN })).rejects.toThrow('not found');
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe('End Event from inside the live room (socket host:end_session)', () => {
  /** Each user's acting-as-host override on this event: false is "in the room as a participant". */
  const overrides: Record<string, boolean | null> = {};

  beforeEach(() => {
    for (const k of Object.keys(overrides)) delete overrides[k];
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const flat = String(sql).replace(/\s+/g, ' ');
      const userId = params[1] as string;
      if (flat.includes('SELECT acting_as_host FROM session_participants')) {
        return { rows: userId in overrides ? [{ acting_as_host: overrides[userId] }] : [] };
      }
      if (flat.includes('SELECT host_user_id FROM sessions')) return { rows: [{ host_user_id: HOST }] };
      if (flat.includes('SELECT pod_id FROM sessions')) return { rows: [{ pod_id: null }] };
      if (flat.includes('FROM session_cohosts')) return { rows: userId === COHOST ? [{ role: 'cohost' }] : [] };
      if (flat.includes('SELECT status FROM session_participants')) return { rows: [{ status: 'in_lobby' }] };
      return { rows: [] };
    });
  });

  function socketOf(userId: string, role: UserRole) {
    const emitted: Array<[string, unknown]> = [];
    const socket = { data: { userId, role }, emit: (event: string, payload: unknown) => { emitted.push([event, payload]); } };
    return { socket: socket as unknown as Parameters<typeof handleHostEnd>[1], emitted };
  }

  it('a super admin in the room as a participant ends the event', async () => {
    overrides[SUPER] = false;
    const { socket, emitted } = socketOf(SUPER, UserRole.SUPER_ADMIN);
    await handleHostEnd(fakeIo, socket, { sessionId: EVENT, endEvent: true });
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
    expect(emitted).toEqual([]);
  });

  it('that super admin still cannot end a round as a participant', async () => {
    overrides[SUPER] = false;
    const { socket, emitted } = socketOf(SUPER, UserRole.SUPER_ADMIN);
    await handleHostEnd(fakeIo, socket, { sessionId: EVENT, endEvent: false });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(emitted[0]?.[0]).toBe('error');
  });

  it('a plain admin in the room is refused, as today', async () => {
    const { socket, emitted } = socketOf(ADMIN, UserRole.ADMIN);
    await handleHostEnd(fakeIo, socket, { sessionId: EVENT, endEvent: true });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(emitted).toEqual([['error', expect.objectContaining({ code: 'FORBIDDEN' })]]);
  });

  it('a co-host may not end the event, as today', async () => {
    const { socket, emitted } = socketOf(COHOST, UserRole.MEMBER);
    await handleHostEnd(fakeIo, socket, { sessionId: EVENT, endEvent: true });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(emitted).toEqual([['error', expect.objectContaining({ code: 'DIRECTOR_ONLY' })]]);
  });

  it('the host ends it, as today', async () => {
    const { socket } = socketOf(HOST, UserRole.MEMBER);
    await handleHostEnd(fakeIo, socket, { sessionId: EVENT, endEvent: true });
    expect(mockComplete).toHaveBeenCalledWith(fakeIo, EVENT);
  });
});
