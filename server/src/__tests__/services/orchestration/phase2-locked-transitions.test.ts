// Phase 2 (25 May 2026) — Session-FSM precondition guards and timer serialization.
// Covers audit findings C1, C2, C3 from the canonical-room-state Phase 2 spec.

import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';

// Mock collaborators that endRound touches so we can drive it in isolation.
jest.mock('../../../db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: jest.fn(async () => {}),
  getSessionById: jest.fn(async () => ({ lobbyRoomId: null })),
  incrementRoundsCompletedBatch: jest.fn(async () => {}),
}));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
}));

const io: any = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) };

import { endRound, transitionToRound, completeSession } from '../../../services/orchestration/handlers/round-lifecycle';

function makeSession(status: SessionStatus) {
  activeSessions.set('s2', {
    sessionId: 's2', hostUserId: 'h', config: { numberOfRounds: 3, ratingWindowSeconds: 30 } as any,
    currentRound: 1, status, timer: null, timerSyncInterval: null, timerEndsAt: null,
    isPaused: false, pausedTimeRemaining: null, presenceMap: new Map(),
    pendingRoundNumber: null, manuallyLeftRound: new Set(),
  } as any);
}
afterEach(() => { activeSessions.delete('s2'); jest.clearAllMocks(); });

import * as fs from 'fs';
import * as path from 'path';
describe('Phase 2 — timer callbacks are guarded (C1)', () => {
  it('wraps each timer callback in withSessionGuard', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/orchestration/orchestration.service.ts'), 'utf8');
    const block = src.slice(src.indexOf('const timerCallbacks'), src.indexOf('const timerCallbacks') + 600);
    expect(block).toMatch(/transitionToRound:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/endRound:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/endRatingWindow:\s*\(sessionId, roundNumber\)\s*=>\s*withSessionGuard\(/);
    expect(block).toMatch(/completeSession:\s*\(sessionId\)\s*=>\s*withSessionGuard\(/);
  });
});

describe('Phase 2 — transitionToRound precondition (C2)', () => {
  it('is a no-op when already ROUND_ACTIVE (duplicate start)', async () => {
    makeSession(SessionStatus.ROUND_ACTIVE);
    const sessionService = require('../../../services/session/session.service');
    await transitionToRound(io, 's2', 1);
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});

describe('Phase 2 — completeSession idempotency (C2)', () => {
  it('is a no-op when already COMPLETED', async () => {
    makeSession(SessionStatus.COMPLETED);
    const sessionService = require('../../../services/session/session.service');
    await completeSession(io, 's2');
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});

describe('Phase 2 — endRound precondition (C2)', () => {
  it('transitions to ROUND_RATING from ROUND_ACTIVE', async () => {
    makeSession(SessionStatus.ROUND_ACTIVE);
    await endRound(io, 's2', 1);
    expect(activeSessions.get('s2')!.status).toBe(SessionStatus.ROUND_RATING);
  });

  it('is a no-op when already in ROUND_RATING (duplicate timer+host fire)', async () => {
    makeSession(SessionStatus.ROUND_RATING);
    const sessionService = require('../../../services/session/session.service');
    await endRound(io, 's2', 1);
    // Still ROUND_RATING and did NOT re-issue the status write
    expect(activeSessions.get('s2')!.status).toBe(SessionStatus.ROUND_RATING);
    expect(sessionService.updateSessionStatus).not.toHaveBeenCalled();
  });
});
