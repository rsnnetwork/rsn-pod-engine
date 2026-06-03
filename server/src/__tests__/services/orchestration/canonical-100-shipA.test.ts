// Canonical-100% Ship A — snapshot v2 (per-recipient `you` + token-on-location-
// change + resync-with-token) and the location-semantics fixes that feed it.
import { SessionStatus } from '@rsn/shared';

const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _t: number, v: string) => { store.set(k, v); return 'OK'; }),
};
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => fakeRedis }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
// Force the snapshot emit flag ON regardless of test env.
jest.mock('../../../config', () => {
  const actual = jest.requireActual('../../../config') as any;
  return { ...actual, config: { ...actual.config, snapshotEmitEnabled: true } };
});
// state-snapshot dynamically imports session.service for lobbyRoomId + minting.
const mintMock = jest.fn(async () => ({ token: 'tok-x', livekitUrl: 'wss://lk' }));
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(async () => ({ lobbyRoomId: 'lobby-1' })),
  generateLiveKitToken: mintMock,
}));

import { writeCanonical } from '../../../services/orchestration/state/canonical-state';
import {
  emitStateSnapshot, handleResync, clearSnapshotLocationCache,
} from '../../../services/orchestration/state/state-snapshot';

type Emit = { room: string; event: string; payload: any };
function makeIo(emits: Emit[]) {
  return { to: (room: string) => ({ emit: (event: string, payload: any) => emits.push({ room, event, payload }) }) } as any;
}

const docBase = (seq: number, participants: any) => ({
  sessionId: 's9', status: SessionStatus.ROUND_ACTIVE, currentRound: 1, seq,
  hostUserId: 'h', timer: { kind: 'round', endsAt: 1234 }, participants,
});

beforeEach(() => { store.clear(); mintMock.mockClear(); clearSnapshotLocationCache(); });

describe('Ship A — emitStateSnapshot v2 (per-recipient you, token on location change)', () => {
  it('emits one per-recipient snapshot per CONNECTED participant with their you block + timer', async () => {
    await writeCanonical(docBase(5, {
      u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 5 },
      u2: { role: 'participant', connState: 'connected', location: { type: 'breakout', roomId: 'r2', matchId: 'm2' }, lastSeenAt: 1, userSeq: 5 },
      u3: { role: 'participant', connState: 'disconnected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 5 },
    }) as any);
    const emits: Emit[] = [];
    await emitStateSnapshot(makeIo(emits), 's9');

    expect(emits).toHaveLength(2); // u3 disconnected → no personal emit
    const byRoom = Object.fromEntries(emits.map(e => [e.room, e.payload]));
    expect(byRoom['user:u1'].you.location).toEqual({ type: 'main' });
    expect(byRoom['user:u2'].you.location).toEqual({ type: 'breakout', roomId: 'r2', matchId: 'm2' });
    expect(byRoom['user:u1'].timer).toEqual({ endsAt: 1234 });
    // First sighting → no token minted (clients already hold working tokens).
    expect(byRoom['user:u1'].you.token).toBeUndefined();
    expect(byRoom['user:u2'].you.token).toBeUndefined();
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints a token ONLY for the participant whose location changed since the last emit', async () => {
    await writeCanonical(docBase(5, {
      u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 5 },
      u2: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 5 },
    }) as any);
    await emitStateSnapshot(makeIo([]), 's9'); // records locations

    await writeCanonical(docBase(6, {
      u1: { role: 'participant', connState: 'connected', location: { type: 'breakout', roomId: 'r7', matchId: 'm7' }, lastSeenAt: 2, userSeq: 6 },
      u2: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 2, userSeq: 6 },
    }) as any);
    const emits: Emit[] = [];
    await emitStateSnapshot(makeIo(emits), 's9');

    const byRoom = Object.fromEntries(emits.map(e => [e.room, e.payload]));
    expect(byRoom['user:u1'].you.token).toBe('tok-x');       // moved → minted
    expect(byRoom['user:u1'].you.roomId).toBe('r7');
    expect(byRoom['user:u2'].you.token).toBeUndefined();     // unchanged → cheap
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith('s9', 'u1', 'r7');
  });

  it('handleResync replies to the requesting socket with you + a freshly minted token (always)', async () => {
    await writeCanonical(docBase(8, {
      u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 8 },
    }) as any);
    const sent: any[] = [];
    const socket = { data: { userId: 'u1' }, emit: (_e: string, p: any) => sent.push(p) } as any;
    await handleResync(makeIo([]), socket, { sessionId: 's9', haveSeq: 3 });

    expect(sent).toHaveLength(1);
    expect(sent[0].you.location).toEqual({ type: 'main' });
    expect(sent[0].you.token).toBe('tok-x');
    expect(sent[0].you.roomId).toBe('lobby-1'); // main → lobby room
    expect(mintMock).toHaveBeenCalledWith('s9', 'u1', 'lobby-1');
  });
});

// ── Source invariants (location semantics + client wiring) ──────────────────
import * as fs from 'fs';
import * as path from 'path';
const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
const readClient = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../../client/src/', rel), 'utf8');

describe('Ship A — location semantics + wiring invariants', () => {
  it('transitionParticipant: disconnect/terminal states do NOT touch canonical location (design §4.1)', () => {
    const src = readSrc('services/orchestration/state/participant-state-machine.ts');
    const i = src.indexOf('const canonPatch');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 800);
    // location only set for IN_BREAKOUT or explicitly non-terminal states.
    expect(block).toMatch(/toState !== ParticipantState\.DISCONNECTED/);
    // and the breakout write carries the caller-provided matchId, not ''.
    expect(block).toMatch(/matchId: opts\.matchId \?\? ''/);
  });

  it('setRoomAssignment mirrors the room assignment into canonical location with the REAL matchId', () => {
    const src = readSrc('services/orchestration/handlers/participant-flow.ts');
    const i = src.indexOf('export function setRoomAssignment');
    const block = src.slice(i, i + 1600);
    expect(block).toMatch(/updateCanonicalParticipant/);
    expect(block).toMatch(/type: 'breakout', roomId, matchId/);
  });

  it('client emits session:resync (with haveSeq) on socket reconnect', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    const i = src.indexOf('const onReconnect');
    const block = src.slice(i, i + 1200);
    expect(block).toMatch(/emit\(\s*'session:resync',\s*\{\s*sessionId,\s*haveSeq/);
  });

  it('client snapshot handler heals location only when seq-newer, and never fights a fresh assignment', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    const i = src.indexOf("socket.on('state:snapshot'");
    const block = src.slice(i, i + 2600);
    expect(block).toMatch(/data\.seq <= prevSeq\) return/);
    expect(block).toMatch(/lastRoomEventAtRef\.current < 10_000/);
    expect(block).toMatch(/setLobbyToken\(you\.token, you\.livekitUrl/);
  });
});
