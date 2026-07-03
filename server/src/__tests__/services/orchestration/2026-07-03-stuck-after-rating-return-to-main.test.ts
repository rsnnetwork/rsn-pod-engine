// 3 Jul live test (Stefan "THE TEST") — participants were STUCK after the
// rating screen and never returned to the main room, so the host couldn't
// start round 2. Root cause: return-to-main had no proactive server rail —
// `emitStateSnapshot` (which pushes each participant their main-room `you` +
// lobby token) was called from ONE place only (the host-dashboard emit),
// never at the round→transition boundary. A flapping/backgrounded client that
// missed the single `session:status_changed` broadcast was never pushed back.
// And nothing healed a straggler whose canonical location was left pointing at
// an already-ended breakout unless THEY happened to send a resync.
//
// Two additive rails (mirror the S27 "stuck-at-start" multi-rail fix):
//   1. proactive emitStateSnapshot at endRatingWindow → ROUND_TRANSITION
//   2. healStrandedBreakoutLocations() run by the periodic LiveKit sweep, so a
//      participant left in a dead breakout is converged to main within one
//      tick even if they never send a clean resync.
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

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import { writeCanonical, readCanonical } from '../../../services/orchestration/state/canonical-state';
import { healStrandedBreakoutLocations } from '../../../services/orchestration/state/livekit-sweep';

const doc = (participants: any) => ({
  sessionId: 's1', status: SessionStatus.ROUND_TRANSITION, currentRound: 1, seq: 10,
  hostUserId: 'h', timer: null, participants,
});
const inRoom = (roomId: string, matchId: string) => ({
  role: 'participant', connState: 'connected',
  location: { type: 'breakout', roomId, matchId }, lastSeenAt: 1, userSeq: 1,
});
const atMain = () => ({
  role: 'participant', connState: 'connected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 1,
});

beforeEach(() => { store.clear(); mockQuery.mockReset(); });

describe('healStrandedBreakoutLocations', () => {
  it('returns a participant stranded in an ENDED breakout to main', async () => {
    await writeCanonical(doc({ u1: inRoom('r1', 'm-ended') }) as any);
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] }); // m-ended

    const healed = await healStrandedBreakoutLocations('s1');

    expect(healed).toEqual(['u1']);
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'main' });
  });

  it('leaves a participant in a STILL-ACTIVE breakout untouched', async () => {
    await writeCanonical(doc({ u1: inRoom('r2', 'm-live') }) as any);
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }] }); // m-live

    const healed = await healStrandedBreakoutLocations('s1');

    expect(healed).toEqual([]);
    const d = await readCanonical('s1');
    expect(d!.participants.u1.location).toEqual({ type: 'breakout', roomId: 'r2', matchId: 'm-live' });
  });

  it('never touches participants already in main (no match lookup for them)', async () => {
    await writeCanonical(doc({ u1: atMain(), u2: atMain() }) as any);
    const healed = await healStrandedBreakoutLocations('s1');
    expect(healed).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('no-ops safely on a missing session doc', async () => {
    const healed = await healStrandedBreakoutLocations('missing');
    expect(healed).toEqual([]);
  });
});

// ── Source invariants: the two delivery rails must be wired ──────────────────
import * as fs from 'fs';
import * as path from 'path';
const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

describe('return-to-main delivery rails are wired', () => {
  it('rail 1 — endRatingWindow proactively pushes a snapshot on ROUND_TRANSITION', () => {
    const src = readSrc('services/orchestration/handlers/round-lifecycle.ts');
    const i = src.indexOf('export async function endRatingWindow');
    const fn = src.slice(i, src.indexOf('\nexport ', i + 10));
    expect(fn).toMatch(/emitStateSnapshot/);
  });

  it('rail 1b — endRatingWindow ALSO pushes on the CLOSING_LOBBY (last-round) branch', () => {
    // 3 Jul: the last round → CLOSING_LOBBY had no proactive push (unlike
    // ROUND_TRANSITION, which is also followed by a next-round start), so the
    // whole room got stuck alone. Both branches must emit the snapshot.
    const src = readSrc('services/orchestration/handlers/round-lifecycle.ts');
    const i = src.indexOf('export async function endRatingWindow');
    const fn = src.slice(i, src.indexOf('\nexport ', i + 10));
    const count = (fn.match(/emitStateSnapshot/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('rail 2 — the periodic LiveKit sweep runs healStrandedBreakoutLocations', () => {
    const src = readSrc('services/orchestration/state/livekit-sweep.ts');
    const i = src.indexOf('export function startLiveKitSweep');
    const fn = src.slice(i, src.length);
    expect(fn).toMatch(/healStrandedBreakoutLocations/);
  });
});
