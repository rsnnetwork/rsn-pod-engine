// ─── Go Live picks the plan: the published schedule, or the engine as before (10 Nov 2026 spec, Part 2 Task 9) ──
//
// handleHostStart plans a rounds event once. An event with a published schedule version is started from it
// (materialisePublished); every other event calls generateSessionSchedule with exactly the arguments it always had.
// Either way the room hears host:event_plan_generated. The service side is in start-uses-published.test.ts.

const gMockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (/^\s*UPDATE sessions SET/.test(sql)) return { rows: [sessionRow(params[params.length - 1] as string)], rowCount: 1 };
  if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [sessionRow(params[0] as string)] };
  return { rows: [] };
});
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => (gMockQuery as jest.Mock)(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: gMockQuery })),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async () => ({ allowed: true, effectiveRole: 'host' })), __esModule: true,
}));
jest.mock('../../../services/video/video.service', () => ({
  createLobbyRoom: jest.fn(async (sid: string) => ({ roomId: `lobby-${sid}` })),
  closeLobbyRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `lobby-${sid}`,
  __esModule: true,
}));
const mockGenerateSessionSchedule = jest.fn(async () => ({ rounds: [{ roundNumber: 1, pairs: [] }], durationMs: 1 }));
jest.mock('../../../services/matching/matching.service', () => ({
  generateSessionSchedule: (...args: unknown[]) => (mockGenerateSessionSchedule as jest.Mock)(...args),
  __esModule: true,
}));
const mockHasPublished = jest.fn(async () => false);
const mockMaterialisePublished = jest.fn(async () => ({ rounds: [{ roundNumber: 1, pairs: [] }, { roundNumber: 2, pairs: [] }], durationMs: 2 }));
jest.mock('../../../services/schedule/schedule-live.service', () => ({
  hasPublishedSchedule: (...args: unknown[]) => (mockHasPublished as jest.Mock)(...args),
  materialisePublished: (...args: unknown[]) => (mockMaterialisePublished as jest.Mock)(...args),
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));

import { activeSessions } from '../../../services/orchestration/state/session-state';
import { handleHostStart, setHostActionsIo } from '../../../services/orchestration/handlers/host-actions';

const HOST = 'host-user';
const status = new Map<string, string>();

function sessionRow(id: string) {
  return {
    id, podId: 'pod-1', hostUserId: HOST, title: 'Event', status: status.get(id) ?? 'scheduled', lobbyRoomId: `lobby-${id}`,
    startedAt: null, currentRound: 0, format: 'speed_networking',
    config: { numberOfRounds: 3, eventType: 'speed_networking', durationMinutes: 60 },
  };
}

const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
const io: any = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
  in: () => ({ fetchSockets: async () => [] }),
  sockets: { sockets: new Map() },
};
const hostSocket = () => ({
  id: 'socket-host', data: { userId: HOST, role: 'member', displayName: 'Host' },
  rooms: new Set<string>(), emit: jest.fn(), join: jest.fn(), leave: jest.fn(),
}) as any;

beforeEach(() => {
  status.clear();
  emitted.length = 0;
  activeSessions.clear();
  setHostActionsIo(io);
  mockGenerateSessionSchedule.mockClear();
  mockMaterialisePublished.mockClear();
  mockHasPublished.mockReset();
});

it('an event without a published version is planned by the engine, with the same arguments as before', async () => {
  mockHasPublished.mockResolvedValue(false);
  const socket = hostSocket();
  await handleHostStart(io, socket, { sessionId: 'no-board' });

  expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  expect(mockHasPublished).toHaveBeenCalledWith('no-board');
  expect(mockGenerateSessionSchedule).toHaveBeenCalledTimes(1);
  expect(mockGenerateSessionSchedule).toHaveBeenCalledWith('no-board', undefined, [HOST], expect.any(Set));
  expect(mockMaterialisePublished).not.toHaveBeenCalled();
  expect(emitted).toContainEqual({
    room: 'session:no-board', event: 'host:event_plan_generated', payload: { sessionId: 'no-board', roundCount: 1, totalPairs: 0 },
  });
});

it('an event with a published version starts from it, and the room hears the same plan event', async () => {
  mockHasPublished.mockResolvedValue(true);
  const socket = hostSocket();
  await handleHostStart(io, socket, { sessionId: 'on-board' });

  expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  expect(mockGenerateSessionSchedule).not.toHaveBeenCalled();
  expect(mockMaterialisePublished).toHaveBeenCalledWith('on-board', { presentUserIds: expect.any(Set), hostIds: [HOST] });
  expect(emitted).toContainEqual({
    room: 'session:on-board', event: 'host:event_plan_generated', payload: { sessionId: 'on-board', roundCount: 2, totalPairs: 0 },
  });
});
