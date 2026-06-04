// Ship A regression fix (4 Jun live test) — canonical location must reset to
// 'main' when a room ends. Room ENTRY writes canonical directly
// (setRoomAssignment); the "return to main" state transitions early-return on
// their idempotent path (in-memory state never goes IN_BREAKOUT), so they
// never reset location. Result pre-fix: after End Round, canonical still said
// 'breakout' and the snapshot/resync wire pulled participants BACK into the
// dead room ~10-30s later.
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

import {
  writeCanonical, readCanonical,
  clearCanonicalBreakoutByMatch, clearCanonicalLocationToMain,
} from '../../../services/orchestration/state/canonical-state';

const doc = (participants: any) => ({
  sessionId: 's1', status: SessionStatus.ROUND_RATING, currentRound: 1, seq: 10,
  hostUserId: 'h', timer: null, participants,
});
const inRoom = (roomId: string, matchId: string) => ({
  role: 'participant', connState: 'connected',
  location: { type: 'breakout', roomId, matchId }, lastSeenAt: 1, userSeq: 1,
});

beforeEach(() => { store.clear(); });

describe('clearCanonicalBreakoutByMatch', () => {
  it('resets location to main ONLY for participants in the given matches', async () => {
    await writeCanonical(doc({
      u1: inRoom('r1', 'm1'),
      u2: inRoom('r1', 'm1'),
      u3: inRoom('r2', 'm2'),   // different (still-live) match — untouched
      u4: { role: 'host', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 1 },
    }) as any);
    await clearCanonicalBreakoutByMatch('s1', ['m1']);
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'main' });
    expect(d!.participants.u2.location).toEqual({ type: 'main' });
    expect(d!.participants.u3.location).toEqual({ type: 'breakout', roomId: 'r2', matchId: 'm2' });
    expect(d!.seq).toBe(11); // one bump for the batch
  });

  it('is race-safe: a user already re-placed into a NEWER match is never stomped', async () => {
    await writeCanonical(doc({ u1: inRoom('r9', 'm-new') }) as any);
    await clearCanonicalBreakoutByMatch('s1', ['m-old']);
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'breakout', roomId: 'r9', matchId: 'm-new' });
    expect(d!.seq).toBe(10); // nothing changed → no bump
  });

  it('does not touch connState and no-ops on missing doc / empty ids', async () => {
    await writeCanonical(doc({ u1: { ...inRoom('r1', 'm1'), connState: 'disconnected' } }) as any);
    await clearCanonicalBreakoutByMatch('s1', ['m1']);
    expect((await readCanonical('s1'))!.participants.u1.connState).toBe('disconnected');
    await clearCanonicalBreakoutByMatch('missing', ['m1']); // no throw
    await clearCanonicalBreakoutByMatch('s1', []);          // no throw
  });
});

describe('canonical RMW serialization (lost-update race)', () => {
  it('concurrent participant patches never clobber each other', async () => {
    // Pre-fix: updateCanonicalParticipant read the whole doc, patched one
    // user, and wrote the whole doc back — two concurrent calls both read
    // the same base doc and the second write erased the first (observed in
    // prod: a heartbeat mirror clobbering a just-written breakout location,
    // which mis-routed room chat to the sender only).
    const { updateCanonicalParticipant } = await import('../../../services/orchestration/state/canonical-state');
    await writeCanonical(doc({
      u1: cp_main(), u2: cp_main(), u3: cp_main(), u4: cp_main(), u5: cp_main(),
    }) as any);
    await Promise.all([
      updateCanonicalParticipant('s1', 'u1', { location: { type: 'breakout', roomId: 'r1', matchId: 'm1' } } as any),
      updateCanonicalParticipant('s1', 'u2', { location: { type: 'breakout', roomId: 'r1', matchId: 'm1' } } as any),
      updateCanonicalParticipant('s1', 'u3', { connState: 'connected', lastSeenAt: 999 } as any),
      updateCanonicalParticipant('s1', 'u4', { connState: 'disconnected' } as any),
      updateCanonicalParticipant('s1', 'u5', { location: { type: 'breakout', roomId: 'r2', matchId: 'm2' } } as any),
    ]);
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'breakout', roomId: 'r1', matchId: 'm1' });
    expect(d!.participants.u2.location).toEqual({ type: 'breakout', roomId: 'r1', matchId: 'm1' });
    expect(d!.participants.u3.lastSeenAt).toBe(999);
    expect(d!.participants.u4.connState).toBe('disconnected');
    expect(d!.participants.u5.location).toEqual({ type: 'breakout', roomId: 'r2', matchId: 'm2' });
    expect(d!.seq).toBe(15); // 10 + exactly one bump per write
  });

  it('mixed helpers serialize too (participant patch vs batch clear)', async () => {
    const { updateCanonicalParticipant } = await import('../../../services/orchestration/state/canonical-state');
    await writeCanonical(doc({ u1: inRoom('r1', 'm-old'), u2: inRoom('r1', 'm-old') }) as any);
    await Promise.all([
      clearCanonicalBreakoutByMatch('s1', ['m-old']),
      updateCanonicalParticipant('s1', 'u2', { location: { type: 'breakout', roomId: 'r9', matchId: 'm-new' } } as any),
    ]);
    const d = await readCanonical('s1');
    // u1 cleared by the batch; u2's NEW placement survives regardless of order
    // (either the clear ran first — m-old matched, then the new write landed —
    // or the new write ran first and the m-old guard skipped u2).
    expect(d!.participants.u1.location).toEqual({ type: 'main' });
    expect(d!.participants.u2.location).toEqual({ type: 'breakout', roomId: 'r9', matchId: 'm-new' });
  });
});

const cp_main = () => ({
  role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 1,
});

describe('shadow projection must never resurrect locations (the ghost engine)', () => {
  it('preserves existing participants verbatim; only adds new ones and doc-level fields', async () => {
    // The Phase-1 shadow projection derived location from the in-memory
    // roomParticipants map, which nothing clears at round end — so every
    // persistSessionState overwrote the whole doc and resurrected the dead
    // breakout location AFTER the room-end clears (the 4-Jun ghost's real
    // engine). Post-fix it merges: existing participants are preserved
    // verbatim (canonical is authoritative), new ones are added, and only
    // doc-level fields (status/round/timer) come from the projection.
    const { shadowWriteCanonical } = await import('../../../services/orchestration/state/canonical-shadow');
    await writeCanonical(doc({
      u1: { role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 5, userSeq: 1 },
    }) as any);

    const activeSession: any = {
      sessionId: 's1', hostUserId: 'h', status: 'round_transition', currentRound: 1,
      timerEndsAt: null,
      presenceMap: new Map([
        ['u1', { lastHeartbeat: new Date(), socketId: 'x' }],
        ['u2', { lastHeartbeat: new Date(), socketId: 'y' }], // new joiner, not in doc yet
      ]),
      // STALE: u1's round-1 room entry that nothing cleaned up
      roomParticipants: new Map([['u1', { matchId: 'm-dead', roomId: 'r-dead', joinedAt: new Date() }]]),
      participantStates: new Map(),
    };
    await shadowWriteCanonical(activeSession);

    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'main' });     // NOT resurrected
    expect(d!.participants.u2).toBeDefined();                          // new joiner added
    expect(d!.participants.u2.location).toEqual({ type: 'main' });
    expect(d!.status).toBe('round_transition');                        // doc-level updated
  });
});

describe('clearCanonicalLocationToMain', () => {
  it('returns one user to main (explicit leave / host pull-back)', async () => {
    await writeCanonical(doc({ u1: inRoom('r1', 'm1'), u2: inRoom('r1', 'm1') }) as any);
    await clearCanonicalLocationToMain('s1', 'u1');
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'main' });
    expect(d!.participants.u2.location).toEqual({ type: 'breakout', roomId: 'r1', matchId: 'm1' }); // trio survivor stays
  });
});

// ── Source invariants — every room-end path clears canonical location ───────
import * as fs from 'fs';
import * as path from 'path';
const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

describe('room-end paths clear canonical location', () => {
  it('endRound batch-clears the round matches (THE reported repro)', () => {
    const src = readSrc('services/orchestration/handlers/round-lifecycle.ts');
    const i = src.indexOf('export async function endRound');
    const fn = src.slice(i, src.indexOf('\nexport ', i + 10));
    expect(fn).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('handleLeaveConversation clears leaver (trio) or whole match (pair)', () => {
    const src = readSrc('services/orchestration/handlers/participant-flow.ts');
    const i = src.indexOf('export async function handleLeaveConversation');
    const fn = src.slice(i, i + 6000);
    expect(fn).toMatch(/clearCanonicalLocationToMain/);
    expect(fn).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('handleHostRemoveFromRoom (pull-back) clears the same way', () => {
    const src = readSrc('services/orchestration/handlers/host-actions.ts');
    const i = src.indexOf('export async function handleHostRemoveFromRoom');
    const fn = src.slice(i, i + 6000);
    expect(fn).toMatch(/clearCanonicalLocationToMain/);
    expect(fn).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('host move-to-room retires both old matches', () => {
    const src = readSrc('services/orchestration/handlers/host-actions.ts');
    const i = src.indexOf('atomic move-to-room transaction');
    const block = src.slice(i, i + 3000);
    expect(block).toMatch(/clearCanonicalBreakoutByMatch\(sessionId, \[currentMatch\.id, targetMatchId\]\)/);
  });

  it('manual-room timer expiry clears (host-actions + breakout-bulk fireCallbacks)', () => {
    const ha = readSrc('services/orchestration/handlers/host-actions.ts');
    const bb = readSrc('services/orchestration/handlers/breakout-bulk.ts');
    // each fireCallback completes the match then clears its canonical locations
    const haFire = ha.slice(ha.lastIndexOf('const fireCallback'));
    expect(haFire).toMatch(/clearCanonicalBreakoutByMatch/);
    const bbFire = bb.slice(bb.indexOf('const fireCallback'));
    expect(bbFire).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('end-all-manual-rooms clears per room', () => {
    const bb = readSrc('services/orchestration/handlers/breakout-bulk.ts');
    const i = bb.indexOf('No active manual rooms to end');
    const block = bb.slice(i, i + 2500);
    expect(block).toMatch(/clearCanonicalBreakoutByMatch/);
  });

  it('reassign-into-new-room paths clear the retired matches (abandoned partners go main)', () => {
    const ha = readSrc('services/orchestration/handlers/host-actions.ts');
    const bb = readSrc('services/orchestration/handlers/breakout-bulk.ts');
    expect(ha).toMatch(/clearCanonicalBreakoutByMatch\([^)]*reassignedForNotification\.map/);
    expect(bb).toMatch(/clearCanonicalBreakoutByMatch\([^)]*reassignedForNotification\.map/);
  });
});
