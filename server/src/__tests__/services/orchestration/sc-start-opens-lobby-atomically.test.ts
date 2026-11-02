// ─── Go Live writes "open" and the lobby room id in one update (2 Nov 2026) ───────────────────────
//
// handleHostStart wrote status = lobby_open, then called LiveKit Cloud to create the room (0.4 to 0.8 s on
// production), and only then wrote lobby_room_id. A token taken in that gap named `session-<id>` and stranded
// the person alone (Script C; 27 such tokens on production since 25 Oct). The REST Go Live twin never wrote the
// room id at all. Both paths now write the status, the lobby room id and started_at in ONE update before the
// LiveKit call, so no reader can see the event open without its lobby. If LiveKit then fails, the event stays
// open as before (the error is logged as before); LiveKit creates the room on the first join.
//
// The database here is a tiny interpreter over the UPDATEs the real session service sends, so the test reads
// the row exactly as another request would see it at every moment.

type Row = { status: string; lobby_room_id: string | null; started_at: unknown };
const rows = new Map<string, Row>();
const invariantBreaks: string[] = [];
const timeline: string[] = [];

function applyUpdate(sql: string, params: unknown[]) {
  const m = sql.match(/UPDATE sessions SET ([\s\S]+?) WHERE id = \$(\d+)/);
  if (!m) return;
  const id = params[Number(m[2]) - 1] as string;
  const row = rows.get(id);
  if (!row) return;
  for (const clause of m[1].split(/,\s*/)) {
    const [col, rhs] = clause.split(/\s*=\s*/);
    const value = /^\$\d+$/.test(rhs) ? params[Number(rhs.slice(1)) - 1] : rhs === 'NULL' ? null : rhs;
    (row as Record<string, unknown>)[col.trim()] = value;
  }
  timeline.push(`db:${row.status}:${row.lobby_room_id}`);
  if (row.status === 'lobby_open' && !row.lobby_room_id) invariantBreaks.push(sql);
}

const gMockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (/^\s*UPDATE sessions SET/.test(sql)) {
    if (failNextStatusWrite) { failNextStatusWrite = false; throw new Error('db down'); }
    applyUpdate(sql, params);
    const row = rows.get(params[params.length - 1] as string);
    return { rows: [row ? sessionRow(params[params.length - 1] as string) : undefined], rowCount: 1 };
  }
  if (/SELECT status FROM sessions WHERE id = \$1/.test(sql)) {
    return { rows: [{ status: rows.get(params[0] as string)?.status }] };
  }
  if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [sessionRow(params[0] as string)] };
  return { rows: [] };
});
let failNextStatusWrite = false;
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => (gMockQuery as jest.Mock)(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: gMockQuery })),
  __esModule: true,
}));

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../../config/logger', () => ({ default: mockLogger, __esModule: true }));

jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async () => ({ allowed: true, effectiveRole: 'host' })),
  __esModule: true,
}));

const mockCreateLobbyRoom = jest.fn();
jest.mock('../../../services/video/video.service', () => ({
  createLobbyRoom: (...args: unknown[]) => mockCreateLobbyRoom(...args),
  closeLobbyRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `lobby-${sid}`,
  __esModule: true,
}));

jest.mock('../../../services/matching/matching.service', () => ({
  generateSessionSchedule: jest.fn(async () => ({ rounds: [], durationMs: 1 })),
  __esModule: true,
}));

jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));

import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import { handleHostStart, startSession } from '../../../services/orchestration/handlers/host-actions';

const HOST = 'host-user';
const formats = new Map<string, string>();

function sessionRow(id: string) {
  const r = rows.get(id)!;
  const format = formats.get(id) ?? 'speed_networking';
  return {
    id, podId: 'pod-1', hostUserId: HOST, title: 'Event', status: r.status, lobbyRoomId: r.lobby_room_id,
    startedAt: r.started_at ?? null, currentRound: 0, format,
    config: { numberOfRounds: 3, eventType: format, durationMinutes: 60 },
  };
}

function scheduled(id: string, format = 'speed_networking') {
  rows.set(id, { status: 'scheduled', lobby_room_id: null, started_at: null });
  formats.set(id, format);
}

const emitted: Array<{ room: string; event: string }> = [];
const io: any = {
  to: (room: string) => ({ emit: (event: string) => { emitted.push({ room, event }); } }),
  in: () => ({ fetchSockets: async () => [] }),
  sockets: { sockets: new Map() },
};
function hostSocket() {
  return {
    id: 'socket-host', data: { userId: HOST, role: 'member', displayName: 'Host' },
    rooms: new Set<string>(), emit: jest.fn(), join: jest.fn(), leave: jest.fn(),
  } as any;
}

beforeEach(() => {
  rows.clear();
  formats.clear();
  invariantBreaks.length = 0;
  timeline.length = 0;
  emitted.length = 0;
  failNextStatusWrite = false;
  activeSessions.clear();
  mockCreateLobbyRoom.mockReset();
  mockLogger.warn.mockClear();
  mockCreateLobbyRoom.mockImplementation(async (sid: string) => {
    const r = rows.get(sid)!;
    timeline.push(`livekit:createLobbyRoom seen-as ${r.status}:${r.lobby_room_id}`);
    return { roomId: `lobby-${sid}` };
  });
});

describe.each(['speed_networking', 'video_meeting'])('Go Live over the socket (%s)', (format) => {
  it('never shows the event open without its lobby room id, and writes both before calling LiveKit', async () => {
    const sid = `start-${format}`;
    scheduled(sid, format);
    const socket = hostSocket();
    await handleHostStart(io, socket, { sessionId: sid });

    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expect(invariantBreaks).toEqual([]);
    expect(rows.get(sid)).toMatchObject({ status: 'lobby_open', lobby_room_id: `lobby-${sid}` });
    expect(rows.get(sid)!.started_at).toBeTruthy();
    // The first write already carries the room; LiveKit is called after it, never before.
    expect(timeline[0]).toBe(`db:lobby_open:lobby-${sid}`);
    expect(timeline).toContain(`livekit:createLobbyRoom seen-as lobby_open:lobby-${sid}`);
    expect(activeSessions.get(sid)?.status).toBe(SessionStatus.LOBBY_OPEN);
    expect(emitted).toContainEqual({ room: `session:${sid}`, event: 'session:status_changed' });
  });
});

describe('Go Live when LiveKit fails to create the room', () => {
  it('the event is open with its lobby room id, the failure is logged as before, and every page is told', async () => {
    const sid = 'start-lk-down';
    scheduled(sid);
    mockCreateLobbyRoom.mockRejectedValue(new Error('LiveKit Cloud unreachable'));
    const socket = hostSocket();
    await handleHostStart(io, socket, { sessionId: sid });

    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    expect(invariantBreaks).toEqual([]);
    expect(rows.get(sid)).toMatchObject({ status: 'lobby_open', lobby_room_id: `lobby-${sid}` });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: sid }),
      'Failed to create lobby LiveKit room — continuing without video mosaic',
    );
    expect(activeSessions.get(sid)?.status).toBe(SessionStatus.LOBBY_OPEN);
    expect(emitted).toContainEqual({ room: `session:${sid}`, event: 'session:status_changed' });
  });

  it('a failed status write opens nothing: no LiveKit call, START_FAILED as before', async () => {
    const sid = 'start-db-down';
    scheduled(sid);
    failNextStatusWrite = true;
    const socket = hostSocket();
    await handleHostStart(io, socket, { sessionId: sid });

    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'START_FAILED' }));
    expect(rows.get(sid)!.status).toBe('scheduled');
    expect(mockCreateLobbyRoom).not.toHaveBeenCalled();
    expect(activeSessions.has(sid)).toBe(false);
  });
});

describe('Go Live over REST (POST /sessions/:id/host/start)', () => {
  it('writes the status, the lobby room id and started_at in one update, then creates the room', async () => {
    const sid = 'rest-start';
    scheduled(sid);
    await startSession(sid, HOST);

    expect(invariantBreaks).toEqual([]);
    expect(rows.get(sid)).toMatchObject({ status: 'lobby_open', lobby_room_id: `lobby-${sid}` });
    expect(rows.get(sid)!.started_at).toBeTruthy();
    expect(timeline[0]).toBe(`db:lobby_open:lobby-${sid}`);
    expect(mockCreateLobbyRoom).toHaveBeenCalledWith(sid);
    expect(activeSessions.get(sid)?.status).toBe(SessionStatus.LOBBY_OPEN);
  });

  it('a LiveKit failure does not fail the REST start', async () => {
    const sid = 'rest-start-lk-down';
    scheduled(sid);
    mockCreateLobbyRoom.mockRejectedValue(new Error('LiveKit Cloud unreachable'));
    await expect(startSession(sid, HOST)).resolves.toBeUndefined();
    expect(rows.get(sid)).toMatchObject({ status: 'lobby_open', lobby_room_id: `lobby-${sid}` });
  });
});
