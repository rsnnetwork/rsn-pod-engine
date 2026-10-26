// ─── The event state's host-panel list goes only to the people who run the event (H1, fix round 1) ──────
//
// GET /sessions/:id/state returns the live snapshot. While the event is held in memory it carries
// hccParticipants: the Host Control Center's list, with every registered person's email, platform role, state
// and join time. Production's client reads it only in the Host Control Center (HostControlCenter.tsx, rendered
// for the host, a co-host or a super admin). Anyone else the endpoint lets through now gets it empty; every
// other field is unchanged.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm',
    magicLinkExpiryMinutes: 15, clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/session/session.service');
jest.mock('../../services/pod/pod.service');
jest.mock('../../realtime/emit', () => ({
  emitEntities: jest.fn(async () => {}),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/session/session-access', () => ({
  canViewSession: jest.fn(async () => true),
  __esModule: true,
}));
const mockSnapshot = jest.fn();
jest.mock('../../services/session/session-state-snapshot.service', () => ({
  buildSessionStateSnapshot: (...args: unknown[]) => mockSnapshot(...args),
  __esModule: true,
}));

import sessionRoutes from '../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const SESSION_ID = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const HOST = 'user-host';
const COHOST = 'user-cohost';
const MEMBER = 'user-member';
const OTHER = 'user-other';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/sessions', sessionRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@token.test`, role, sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });

const HCC = [
  {
    userId: MEMBER, displayName: 'Member', email: 'member@rsn-e2e.invalid', role: 'participant', globalRole: 'user',
    state: 'in_main_room', currentMatchId: null, currentRoomId: null, joinedAt: '2026-10-26T06:00:00.000Z',
  },
];
function snapshot() {
  return {
    sessionId: SESSION_ID, sessionStatus: 'lobby_open', currentRound: 1, totalRounds: 3, hostUserId: HOST,
    cohosts: [COHOST], connectedParticipants: [{ userId: MEMBER, displayName: 'Member' }], hostInLobby: true,
    participantCounts: { connected: 1, registered: 1, active: 1, hostConnected: true, ghostFiltered: true, hostsRegistered: 2, hostsConnected: 1 },
    hostMutedUserIds: [], actingAsHostOverrides: {}, hccParticipants: HCC,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => (
    /SELECT status FROM users WHERE id = \$1/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [] }
  ));
  mockSnapshot.mockReset();
  mockSnapshot.mockResolvedValue(snapshot());
});

describe('GET /sessions/:id/state', () => {
  it('a participant gets the event state without the host panel list, so no one\'s email', async () => {
    for (const viewer of [MEMBER, OTHER]) {
      const res = await request(app()).get(`/sessions/${SESSION_ID}/state`).set('Authorization', `Bearer ${token(viewer)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.hccParticipants).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('@');
      const { hccParticipants: _stripped, ...rest } = snapshot();
      const { hccParticipants: _empty, ...restOut } = res.body.data;
      expect(restOut).toEqual(rest);
    }
  });

  it('the host, a co-host, an admin and a super admin still get it', async () => {
    for (const [viewer, role] of [[HOST, 'member'], [COHOST, 'member'], [OTHER, 'admin'], [OTHER, 'super_admin']]) {
      const res = await request(app()).get(`/sessions/${SESSION_ID}/state`).set('Authorization', `Bearer ${token(viewer, role)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.hccParticipants).toEqual(HCC);
    }
  });
});
