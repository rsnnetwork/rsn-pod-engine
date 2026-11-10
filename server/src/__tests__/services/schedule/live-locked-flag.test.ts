// ─── The host's live screens say which meetings are locked on the board (Part 2 Task 9 follow-up) ─────────────
//
// The board UI shows a "Locked" badge in the live room. The two host-only payloads that list a round's rooms carry
// the flag, read from matches.locked: host:match_preview (each previewed meeting) and host:round_dashboard (each live
// room, from the canonical builder and from the reconnect replay). An event without a board has no locked row, so it
// sends locked: false on every room.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: mockQuery })),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(async () => ({ id: 'ev', hostUserId: 'host', lobbyRoomId: null, config: { matchingPolicy: 'within_event' } })),
  __esModule: true,
}));
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  getCanonicalConnectedSet: jest.fn(async () => null),
  __esModule: true,
}));
jest.mock('../../../services/orchestration/handlers/host-participants-view', () => ({
  buildHostParticipantsView: jest.fn(async () => []),
  __esModule: true,
}));

import * as fs from 'fs';
import * as path from 'path';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import { emitHostDashboardForce, sendMatchPreview } from '../../../services/orchestration/handlers/matching-flow';

const EVENT = '00000000-0000-4000-8000-0000000000aa';
interface Row { id: string; a: string; b: string; c: string | null; status: string; locked: boolean }

function world(rows: Row[]): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM matches WHERE session_id = \$1 AND round_number = \$2/.test(sql)) {
      expect(sql).toMatch(/is_manual AS "isManual", locked,/);
      return {
        rows: rows.map((r) => ({
          id: r.id, sessionId: EVENT, roundNumber: 2, participantAId: r.a, participantBId: r.b, participantCId: r.c,
          departedUserIds: [], roomId: `room-${r.id}`, status: r.status, score: 0, reasonTags: [], isManual: false, locked: r.locked,
        })),
      };
    }
    if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
}

const emitted: Array<{ room: string; event: string; payload: any }> = [];
const io: any = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
  in: () => ({ fetchSockets: async () => [] }),
};
const hostSocket = () => ({ emit: jest.fn() }) as any;

beforeEach(() => {
  mockQuery.mockReset();
  emitted.length = 0;
  activeSessions.clear();
  activeSessions.set(EVENT, {
    sessionId: EVENT, hostUserId: 'host', status: 'round_active', currentRound: 2, presenceMap: new Map(),
    config: { numberOfRounds: 5 }, timerEndsAt: null, pausedTimeRemaining: null, isPaused: false,
  } as any);
});

const BOARD: Row[] = [
  { id: 'm1', a: 'ann', b: 'ben', c: null, status: 'active', locked: true },
  { id: 'm2', a: 'cat', b: 'dev', c: 'eve', status: 'active', locked: false },
];
const NO_BOARD: Row[] = BOARD.map((r) => ({ ...r, locked: false }));

describe('host:match_preview', () => {
  it('each previewed meeting says whether it is locked on the board', async () => {
    world(BOARD.map((r) => ({ ...r, status: 'scheduled' })));
    const socket = hostSocket();
    await sendMatchPreview(io, socket, EVENT, 2, 'host');
    const [event, payload] = socket.emit.mock.calls.find(([e]: [string]) => e === 'host:match_preview');
    expect(event).toBe('host:match_preview');
    expect(payload.matches.map((m: { participantA: { userId: string }; locked: boolean }) => [m.participantA.userId, m.locked]))
      .toEqual([['ann', true], ['cat', false]]);
  });

  it('an event without a board sends locked: false on every meeting', async () => {
    world(NO_BOARD.map((r) => ({ ...r, status: 'scheduled' })));
    const socket = hostSocket();
    await sendMatchPreview(io, socket, EVENT, 2, 'host');
    const [, payload] = socket.emit.mock.calls.find(([e]: [string]) => e === 'host:match_preview');
    expect(payload.matches.map((m: { locked: boolean }) => m.locked)).toEqual([false, false]);
  });
});

describe('host:round_dashboard', () => {
  it('each live room says whether it is locked on the board', async () => {
    world(BOARD);
    await emitHostDashboardForce(io, EVENT);
    const sent = emitted.find((e) => e.event === 'host:round_dashboard');
    expect(sent?.room).toBe('user:host');
    expect(sent!.payload.rooms.map((r: { matchId: string; locked: boolean }) => [r.matchId, r.locked])).toEqual([['m1', true], ['m2', false]]);
  });

  it('an event without a board sends locked: false on every room', async () => {
    world(NO_BOARD);
    await emitHostDashboardForce(io, EVENT);
    const sent = emitted.find((e) => e.event === 'host:round_dashboard');
    expect(sent!.payload.rooms.map((r: { locked: boolean }) => r.locked)).toEqual([false, false]);
  });

  it('the host\'s reconnect replay of the dashboard carries the flag the same way', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'), 'utf8');
    const replay = source.slice(source.indexOf("socket.emit('host:round_dashboard'") - 3000, source.indexOf("socket.emit('host:round_dashboard'"));
    expect(replay).toContain("isTrio: !!m.participantCId, isManual: m.isManual === true,");
    expect(replay).toContain('locked: m.locked === true,');
  });
});
