// server/src/__tests__/services/orchestration/canonical-projection.test.ts
import { SessionStatus } from '@rsn/shared';
import { projectActiveSessionToCanonical } from '../../../services/orchestration/state/canonical-projection';
import type { ActiveSession } from '../../../services/orchestration/state/session-state';

function baseSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 's1',
    hostUserId: 'host1',
    config: {} as any,
    currentRound: 2,
    status: SessionStatus.ROUND_ACTIVE,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: new Date(1_700_000_000_000),
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map(),
    pendingRoundNumber: null,
    manuallyLeftRound: new Set(),
    ...overrides,
  } as ActiveSession;
}

describe('projectActiveSessionToCanonical', () => {
  it('places a room-participant in a breakout and a present-only user in main', () => {
    const s = baseSession({
      presenceMap: new Map([
        ['u1', { lastHeartbeat: new Date(), socketId: 'a' }],
        ['u2', { lastHeartbeat: new Date(), socketId: 'b' }],
      ]),
      roomParticipants: new Map([
        ['u1', { matchId: 'm1', roomId: 'match-s1-r2-abc', joinedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 5);
    expect(doc.participants.u1.location).toEqual({ type: 'breakout', roomId: 'match-s1-r2-abc', matchId: 'm1' });
    expect(doc.participants.u1.connState).toBe('connected');
    expect(doc.participants.u2.location).toEqual({ type: 'main' });
    expect(doc.participants.u2.connState).toBe('connected');
  });

  it('preserves breakout location for a disconnected user (location independent of presence)', () => {
    const s = baseSession({
      presenceMap: new Map(), // u1 NOT present
      roomParticipants: new Map([
        ['u1', { matchId: 'm1', roomId: 'match-s1-r2-abc', joinedAt: new Date() }],
      ]),
      participantStates: new Map([
        ['u1', { state: 'disconnected', currentRoomId: 'match-s1-r2-abc', updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 0);
    expect(doc.participants.u1.location).toEqual({ type: 'breakout', roomId: 'match-s1-r2-abc', matchId: 'm1' });
    expect(doc.participants.u1.connState).toBe('disconnected');
  });

  it('maps terminal participant states to connState and host role', () => {
    const s = baseSession({
      participantStates: new Map([
        ['u3', { state: 'left', currentRoomId: null, updatedAt: new Date() }],
        ['u4', { state: 'no_show', currentRoomId: null, updatedAt: new Date() }],
        ['u7', { state: 'removed', currentRoomId: null, updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 9);
    expect(doc.participants.u3.connState).toBe('left');
    expect(doc.participants.u4.connState).toBe('no_show');
    expect(doc.participants.u7.connState).toBe('removed');
    expect(doc.participants.host1.role).toBe('host');
    expect(doc.participants.host1.location).toEqual({ type: 'main' });
  });

  it('lets live presence win over a stale terminal DB state', () => {
    // Design decision: presenceMap (a live socket NOW) takes precedence over a
    // stale terminal participantStates row. A future refactor must not silently
    // invert this — a user with an active socket is 'connected', not 'left'.
    const s = baseSession({
      presenceMap: new Map([['u5', { lastHeartbeat: new Date(), socketId: 'z' }]]),
      participantStates: new Map([
        ['u5', { state: 'left', currentRoomId: null, updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 0);
    expect(doc.participants.u5.connState).toBe('connected');
  });

  it('falls to disconnected for a non-present user in a non-terminal state', () => {
    // Default branch: present-less + non-terminal (e.g. in_breakout) → disconnected.
    const s = baseSession({
      presenceMap: new Map(), // u6 NOT present
      participantStates: new Map([
        ['u6', { state: 'in_breakout', currentRoomId: 'match-s1-r2-xyz', updatedAt: new Date() }],
      ]),
    });
    const doc = projectActiveSessionToCanonical(s, 0);
    expect(doc.participants.u6.connState).toBe('disconnected');
  });

  it('stamps seq = prevSeq + 1, status, currentRound and timer.endsAt', () => {
    const doc = projectActiveSessionToCanonical(baseSession(), 41);
    expect(doc.seq).toBe(42);
    expect(doc.status).toBe(SessionStatus.ROUND_ACTIVE);
    expect(doc.currentRound).toBe(2);
    expect(doc.timer).toEqual({ kind: SessionStatus.ROUND_ACTIVE, endsAt: 1_700_000_000_000 });
  });
});
