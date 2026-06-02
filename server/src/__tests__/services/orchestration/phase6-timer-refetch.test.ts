// Phase 6 (M2) — segment-timer fire must operate on the CURRENT ActiveSession
// fetched by id, not the reference captured when the timer was armed. If the
// session object is replaced in the map (e.g. recreated on reconnect), the
// captured ref is orphaned and clearing its fields would leak the timer on the
// new object.

import { startSegmentTimer } from '../../../services/orchestration/handlers/timer-manager';
import { activeSessions } from '../../../services/orchestration/state/session-state';

const io: any = { to: () => ({ emit: () => {} }) };

function makeSession(extra: Record<string, unknown> = {}): any {
  return {
    sessionId: 's6', timer: null, timerSyncInterval: null, timerEndsAt: null,
    status: 'round_active', isPaused: false, ...extra,
  };
}

describe('Phase 6 — timer fire re-fetches the live session (M2)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); activeSessions.delete('s6'); });

  it('clears the CURRENT object when the session was replaced after arming', () => {
    activeSessions.set('s6', makeSession());
    let fired = false;
    startSegmentTimer(io, 's6', 1, () => { fired = true; });

    // Simulate the ActiveSession being recreated/replaced in the map.
    const replacement = makeSession({ timer: 'STALE' as any, timerEndsAt: new Date() });
    activeSessions.set('s6', replacement);

    jest.advanceTimersByTime(1000);

    expect(fired).toBe(true);
    // M2: the fire operated on the current (replacement) object, not the orphan.
    expect(replacement.timer).toBeNull();
    expect(replacement.timerEndsAt).toBeNull();
  });

  it('still fires the callback when the session was removed (fallback to captured)', () => {
    activeSessions.set('s6', makeSession());
    let fired = false;
    startSegmentTimer(io, 's6', 1, () => { fired = true; });
    activeSessions.delete('s6'); // session gone
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(fired).toBe(true);
  });
});
