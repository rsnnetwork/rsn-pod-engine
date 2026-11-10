// ─── A token taken while the event is open names the room everyone else is in (2 Nov 2026) ─────────
//
// Script C, and production since at least 25 Oct (27 tokens across 17 events): the host pressed Start before
// any of the event's sockets had joined. The database said "open" about 0.6 s before it held the lobby room id,
// and a token taken over REST in that gap named `session-<id>`, a room nobody else is ever sent to. The client
// never leaves the first room it joins, so that person sat alone for the whole meeting.
//
// generateLiveKitToken now falls back to the lobby every other path uses (`lobby-<id>`, video.service), in
// every phase, unless the caller asks for a breakout they may join. The route test drives production's client
// request shape (`POST /sessions/:id/token` with `{}`, origin/main useSessionSocket.ts and Lobby.tsx) and reads
// the room out of the real signed token.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../../config', () => {
  const actual = jest.requireActual('../../../config') as { config: Record<string, unknown> };
  const cfg = {
    ...actual.config,
    jwtSecret: JWT_SECRET,
    livekitApiKey: 'lk-test-key',
    livekitApiSecret: 'lk-test-secret-that-is-long-enough-for-hs256',
    livekitUrl: 'wss://lk.test',
  };
  return { ...actual, config: cfg, default: cfg, __esModule: true };
});
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

import { generateLiveKitToken } from '../../../services/session/session.service';
import sessionRoutes from '../../../routes/sessions';
import { errorHandler, notFoundHandler } from '../../../middleware/errorHandler';

const SESSION_ID = '7a2d987e-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const HOST = 'user-host';
const MEMBER = 'user-member';
const LOBBY = `lobby-${SESSION_ID}`;
const BREAKOUT = `match-${SESSION_ID}-r1-abc123`;

type SessionRow = { status: string; lobbyRoomId: string | null };

/** The database: one event in `row`'s state, MEMBER a participant, and `breakoutActive` deciding the match read. */
function db(row: SessionRow, opts: { breakoutActive?: boolean; memberOfBreakout?: boolean } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT status, account_kind FROM users WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active', account_kind: 'member' }] };
    if (/FROM sessions WHERE id = \$1/.test(sql)) {
      return {
        rows: [{
          id: SESSION_ID, podId: 'pod-1', hostUserId: HOST, status: row.status, lobbyRoomId: row.lobbyRoomId,
          format: 'speed_networking', config: { numberOfRounds: 3, eventType: 'speed_networking' },
          currentRound: 0, startedAt: null,
        }],
      };
    }
    if (/FROM session_participants WHERE session_id = \$1 AND user_id = \$2/.test(sql)) {
      return { rows: [{ session_id: SESSION_ID, user_id: MEMBER, status: 'in_lobby' }] };
    }
    if (/SELECT display_name FROM users/.test(sql)) return { rows: [{ display_name: 'Dana' }] };
    if (/FROM matches WHERE session_id = \$1 AND room_id = \$2 AND status = 'active'/.test(sql)) {
      return { rows: opts.breakoutActive ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM matches\s+WHERE session_id = \$1 AND room_id = \$2/.test(sql)) {
      return { rows: opts.memberOfBreakout ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM session_cohosts/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
}

function roomOf(token: string): string | undefined {
  const claims = jwt.decode(token) as { video?: { room?: string } } | null;
  return claims?.video?.room;
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('generateLiveKitToken: the room a token names when the event has no lobby room id yet', () => {
  it('open with no lobby room id yet (the Start gap): the lobby everyone else is sent to, not session-<id>', async () => {
    db({ status: 'lobby_open', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('the host taking a token in the gap lands in the same lobby', async () => {
    db({ status: 'lobby_open', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, HOST);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('asking for the lobby by name in the gap is granted the lobby (no stale-breakout detour)', async () => {
    db({ status: 'lobby_open', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER, LOBBY);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('a round in progress with no lobby room id (a REST start, a failed room write) still falls back to the lobby', async () => {
    db({ status: 'round_active', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('an ended event (the lobby room id is cleared at the end) names the lobby too, never session-<id>', async () => {
    db({ status: 'completed', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('a cancelled event names the lobby too', async () => {
    db({ status: 'cancelled', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(LOBBY);
  });

  // Fix round 1 (review Minor 1) — before Go Live nobody is let into the shared main room, exactly as production
  // does today: a scripted mint while the event is scheduled names the isolated session-<id>.
  it('before Go Live (scheduled) a token still names the isolated session-<id>, never the shared lobby', async () => {
    db({ status: 'scheduled', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(`session-${SESSION_ID}`);
  });

  it('before Go Live, asking for the lobby by name is not granted it either', async () => {
    db({ status: 'scheduled', lobbyRoomId: null });
    const { token } = await generateLiveKitToken(SESSION_ID, HOST, LOBBY);
    expect(roomOf(token)).toBe(`session-${SESSION_ID}`);
  });

  it('once the lobby room id is stored it is used as before', async () => {
    db({ status: 'lobby_open', lobbyRoomId: LOBBY });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('a member of an active breakout still gets the breakout, unchanged', async () => {
    db({ status: 'round_active', lobbyRoomId: LOBBY }, { breakoutActive: true, memberOfBreakout: true });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER, BREAKOUT);
    expect(roomOf(token)).toBe(BREAKOUT);
  });

  it('a dead breakout heals to the lobby even when the lobby room id is missing', async () => {
    db({ status: 'round_active', lobbyRoomId: null }, { breakoutActive: false });
    const { token } = await generateLiveKitToken(SESSION_ID, MEMBER, BREAKOUT);
    expect(roomOf(token)).toBe(LOBBY);
  });

  it('a removed member is still refused, unchanged', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM sessions WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: SESSION_ID, hostUserId: HOST, status: 'lobby_open', lobbyRoomId: null, format: 'speed_networking', config: {} }] };
      }
      if (/FROM session_participants/.test(sql)) return { rows: [{ user_id: MEMBER, status: 'removed' }] };
      return { rows: [] };
    });
    await expect(generateLiveKitToken(SESSION_ID, MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("production's client: POST /sessions/:id/token with {} (origin/main useSessionSocket.ts, Lobby.tsx)", () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/sessions', sessionRoutes);
    a.use(notFoundHandler);
    a.use(errorHandler);
    return a;
  }
  const bearer = (sub: string) =>
    jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's' }, JWT_SECRET, { expiresIn: '15m' });

  it('in the Start gap answers 200 with a valid token for the lobby and the LiveKit url, as the client reads them', async () => {
    db({ status: 'lobby_open', lobbyRoomId: null });
    const res = await request(app())
      .post(`/sessions/${SESSION_ID}/token`)
      .set('Authorization', `Bearer ${bearer(MEMBER)}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.livekitUrl).toBe('wss://lk.test');
    const verified = jwt.verify(res.body.data.token, 'lk-test-secret-that-is-long-enough-for-hs256') as {
      sub: string; video: { room: string; roomJoin: boolean };
    };
    expect(verified.sub).toBe(MEMBER);
    expect(verified.video).toMatchObject({ room: LOBBY, roomJoin: true });
  });

  it('before Go Live the same request still answers 200 with a token for the isolated session-<id> (unchanged)', async () => {
    db({ status: 'scheduled', lobbyRoomId: null });
    const res = await request(app())
      .post(`/sessions/${SESSION_ID}/token`)
      .set('Authorization', `Bearer ${bearer(MEMBER)}`)
      .send({});
    expect(res.status).toBe(200);
    expect(roomOf(res.body.data.token)).toBe(`session-${SESSION_ID}`);
  });

  it("the breakout backup fetch ({ roomId }, origin/main VideoRoom.tsx) still gets the member's active breakout", async () => {
    db({ status: 'round_active', lobbyRoomId: LOBBY }, { breakoutActive: true, memberOfBreakout: true });
    const res = await request(app())
      .post(`/sessions/${SESSION_ID}/token`)
      .set('Authorization', `Bearer ${bearer(MEMBER)}`)
      .send({ roomId: BREAKOUT });
    expect(res.status).toBe(200);
    expect(roomOf(res.body.data.token)).toBe(BREAKOUT);
  });
});
