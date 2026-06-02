// Match-generation serialization — the fix for the "group matching is buggy
// at 10-12 users" report.
//
// Root cause: match generation (host generate/regenerate previews + the
// late-joiner / leaver / reconciler future-round repairs) does a read→compute→
// write with no lock. Concurrent runs read the same eligible set, compute
// different pairings, and the last writer clobbers the others — stranding
// users in 1-person rooms or with no match row ("can't join a room").
//
// Fix: a dedicated per-session withMatchGenerationLock serialises every
// match-write path. It is SEPARATE from withSessionGuard (the presence lock
// for join/leave) so a long matching run never blocks joins/leaves.
//
// These tests pin (a) the lock's mutual-exclusion + cross-session concurrency
// behavior and (b) that every match-write entry point is actually wrapped in
// it, so the race can't silently regress.

import nodeFs from 'fs';
import nodePath from 'path';

jest.mock('../../../db', () => ({
  query: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => null,
  __esModule: true,
}));

import {
  withMatchGenerationLock,
  matchGenerationLocks,
  sessionLocks,
} from '../../../services/orchestration/state/session-state';

const SERVER_SRC = nodePath.join(__dirname, '../../..');

describe('withMatchGenerationLock — serialization behavior', () => {
  it('serializes concurrent operations on the same session (no interleave)', async () => {
    const order: string[] = [];
    const a = withMatchGenerationLock('s1', async () => {
      order.push('A-start');
      await new Promise(r => setTimeout(r, 25));
      order.push('A-end');
    });
    // Started while A still holds the lock — must wait for A to fully finish.
    const b = withMatchGenerationLock('s1', async () => {
      order.push('B-start');
      order.push('B-end');
    });

    await Promise.all([a, b]);

    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
  });

  it('does NOT serialize across different sessions', async () => {
    const order: string[] = [];
    const a = withMatchGenerationLock('sA', async () => {
      order.push('A-start');
      await new Promise(r => setTimeout(r, 25));
      order.push('A-end');
    });
    const b = withMatchGenerationLock('sB', async () => {
      order.push('B-start');
      order.push('B-end');
    });

    await Promise.all([a, b]);

    // B (different session) finishes before A's delay elapses — proves the
    // lock is per-session and one session never blocks another.
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
  });

  it('releases the lock even when the operation throws', async () => {
    await expect(
      withMatchGenerationLock('s1', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    // Lock must be released so the next op can proceed.
    expect(matchGenerationLocks.has('s1')).toBe(false);
    let ran = false;
    await withMatchGenerationLock('s1', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('is a DISTINCT lock from the presence guard (does not block joins/leaves)', async () => {
    // The presence guard (sessionLocks) and the match-generation lock
    // (matchGenerationLocks) must be separate maps, so holding one never
    // stalls the other. A held match-generation lock must not register a
    // presence lock for the same session.
    expect(matchGenerationLocks).not.toBe(sessionLocks);
    let observedPresenceLock = false;
    await withMatchGenerationLock('s-distinct', async () => {
      observedPresenceLock = sessionLocks.has('s-distinct');
    });
    expect(observedPresenceLock).toBe(false);
  });
});

describe('match-write paths are wrapped in withMatchGenerationLock', () => {
  function read(rel: string): string {
    return nodeFs.readFileSync(nodePath.join(SERVER_SRC, rel), 'utf8');
  }

  it('host generate/regenerate handlers acquire the match-generation lock', () => {
    const src = read('services/orchestration/handlers/matching-flow.ts');
    // Both preview-producing handlers must serialize match writes.
    const genIdx = src.indexOf('export async function handleHostGenerateMatches');
    const regenIdx = src.indexOf('export async function handleHostRegenerateMatches');
    expect(genIdx).toBeGreaterThan(-1);
    expect(regenIdx).toBeGreaterThan(-1);
    expect(src.slice(genIdx, genIdx + 1400)).toMatch(/withMatchGenerationLock\(/);
    expect(src.slice(regenIdx, regenIdx + 1400)).toMatch(/withMatchGenerationLock\(/);
  });

  it('host generate/regenerate authorize BEFORE the lock and re-verify INSIDE it', () => {
    const src = read('services/orchestration/handlers/matching-flow.ts');
    const genIdx = src.indexOf('export async function handleHostGenerateMatches');
    const block = src.slice(genIdx, genIdx + 1600);
    const preLock = block.indexOf('verifyHost');
    const lock = block.indexOf('withMatchGenerationLock(');
    const postLock = block.indexOf('verifyHost', lock);
    // verifyHost appears before the lock (fast reject of unauthorized queuers)
    // AND again after acquiring it (TOCTOU: privileges may change while queued).
    expect(preLock).toBeGreaterThan(-1);
    expect(preLock).toBeLessThan(lock);
    expect(postLock).toBeGreaterThan(lock);
  });

  it('the late-joiner / leaver repair path uses the match-generation lock', () => {
    const src = read('services/orchestration/handlers/participant-flow.ts');
    const idx = src.indexOf('async function maybeRepairFutureRounds');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 2000)).toMatch(/withMatchGenerationLock\(/);
  });

  it('the reconciler repair path uses the match-generation lock', () => {
    const src = read('services/orchestration/state/participant-state-machine.ts');
    expect(src).toMatch(/withMatchGenerationLock\(/);
  });

  it('repair fromRound is read INSIDE the lock callback (not captured before the wait)', () => {
    // Computing currentRound+1 before awaiting the lock could repair a round
    // that became active while queued. The currentRound read must sit after
    // the withMatchGenerationLock( call (i.e. inside its callback), not before.
    const src = read('services/orchestration/handlers/participant-flow.ts');
    const idx = src.indexOf('async function maybeRepairFutureRounds');
    const block = src.slice(idx, idx + 2200);
    const lockIdx = block.indexOf('withMatchGenerationLock(');
    const repairCallIdx = block.indexOf('repairFutureRounds(sessionId, activeSession.currentRound + 1');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(repairCallIdx).toBeGreaterThan(lockIdx);
  });
});
