// server/src/__tests__/services/orchestration/canonical-shadow-write.test.ts
import { SessionStatus } from '@rsn/shared';

const reads: string[] = [];
const writes: any[] = [];
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  readCanonical: jest.fn(async (id: string) => { reads.push(id); return { seq: 7 }; }),
  // 4 Jun ghost fix — the shadow now MERGES through the serialized helper
  // instead of overwriting via writeCanonical (which resurrected dead
  // breakout locations from the stale roomParticipants map).
  mergeProjectedCanonical: jest.fn(async (state: any) => { writes.push(state); }),
}));

import { shadowWriteCanonical } from '../../../services/orchestration/state/canonical-shadow';
import type { ActiveSession } from '../../../services/orchestration/state/session-state';

function session(): ActiveSession {
  return {
    sessionId: 's1', hostUserId: 'h1', config: {} as any, currentRound: 1,
    status: SessionStatus.LOBBY_OPEN, timer: null, timerSyncInterval: null,
    timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map([['h1', { lastHeartbeat: new Date(), socketId: 'x' }]]),
    pendingRoundNumber: null, manuallyLeftRound: new Set(),
  } as ActiveSession;
}

beforeEach(() => { reads.length = 0; writes.length = 0; jest.clearAllMocks(); });

describe('shadowWriteCanonical', () => {
  it('bumps seq from the previous canonical doc and writes the projection', async () => {
    await shadowWriteCanonical(session());
    expect(reads).toEqual(['s1']);
    expect(writes).toHaveLength(1);
    expect(writes[0].seq).toBe(8); // prev 7 + 1
    expect(writes[0].sessionId).toBe('s1');
    expect(writes[0].participants.h1.role).toBe('host');
  });

  it('never throws (best-effort) even if projection inputs are minimal', async () => {
    await expect(shadowWriteCanonical(session())).resolves.toBeUndefined();
  });
});
