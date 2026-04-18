// Disconnect-rejoin bug fix tests (Change 4.7+).
//
// Reproduces the live-event scenario from session b6cdea35 (2026-04-17):
//   1. Manual room with Waseem + Ali (mobile)
//   2. Ali leaves browser → server marks DISCONNECTED, ends match as 'completed'
//   3. Ali returns to browser → reconnect → status should reset to in_lobby
//      so he is eligible for future manual rooms / rounds.
//   4. rating:window_open should NOT fire for a user who already rated this match
//      (covers the disconnect-rejoin path that bypassed Bug D's round-end dedup).
//
// Two fixes asserted:
//   Fix A — On reconnect, if user has no active match but status is
//           'disconnected' or 'in_round', reset to 'in_lobby'.
//   Fix B — Centralized emitRatingWindowOnce helper that skips the emit
//           if a rating already exists for (matchId, userId).

const dcMockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => dcMockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

describe('Disconnect-rejoin bug fixes', () => {
  beforeEach(() => {
    dcMockQuery.mockReset();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Fix B — emitRatingWindowOnce centralized helper
  // ────────────────────────────────────────────────────────────────────────

  describe('emitRatingWindowOnce helper', () => {
    it('exports emitRatingWindowOnce from session-state', async () => {
      const mod: any = await import('../../../services/orchestration/state/session-state');
      expect(typeof mod.emitRatingWindowOnce).toBe('function');
    });

    it('emits rating:window_open when user has NOT rated this match', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      // No existing rating
      dcMockQuery.mockResolvedValueOnce({ rows: [] });

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };
      const payload = { matchId: 'm1', partnerId: 'p1', durationSeconds: 20 };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', payload);

      expect(dcMockQuery).toHaveBeenCalledTimes(1);
      expect(dcMockQuery.mock.calls[0][0]).toMatch(/SELECT id FROM ratings/);
      expect(io.to).toHaveBeenCalledWith('user:user-a');
      expect(emit).toHaveBeenCalledWith('rating:window_open', payload);
    });

    it('skips emit when user has ALREADY rated this match', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      // Existing rating present
      dcMockQuery.mockResolvedValueOnce({ rows: [{ id: 'rating-existing' }] });

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', { matchId: 'match-1' });

      expect(dcMockQuery).toHaveBeenCalledTimes(1);
      expect(io.to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits when DB query fails (fail-open — better duplicate prompt than missing one)', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      dcMockQuery.mockRejectedValueOnce(new Error('DB down'));

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', { matchId: 'match-1' });

      expect(emit).toHaveBeenCalledWith('rating:window_open', { matchId: 'match-1' });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Fix B — Centralized helper applied to all emit sites
  // ────────────────────────────────────────────────────────────────────────

  describe('rating:window_open emit sites use emitRatingWindowOnce helper', () => {
    it('host-actions.ts uses emitRatingWindowOnce for partner notifications', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );
      // Should reference the helper for at least the partner-notification flows
      expect(content).toMatch(/emitRatingWindowOnce/);
    });

    it('breakout-bulk.ts uses emitRatingWindowOnce for breakout-end emits', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      expect(content).toMatch(/emitRatingWindowOnce/);
    });

    it('participant-flow.ts uses emitRatingWindowOnce for solo-partner reassign emits', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8',
      );
      expect(content).toMatch(/emitRatingWindowOnce/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Fix A — Status reset on reconnect
  // ────────────────────────────────────────────────────────────────────────

  describe('Fix A — handleJoinSession resets stuck status on reconnect', () => {
    it('participant-flow.ts contains the status-reset SQL for disconnected/in_round users with no active match', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8',
      );
      // Look for the WHERE clause restricting to (disconnected, in_round) which is
      // the precise reset scope (not blanket overwrite of valid statuses).
      expect(content).toMatch(/status\s+IN\s*\(\s*'disconnected'\s*,\s*'in_round'\s*\)/);
    });

    it('participant-flow.ts checks for active match before resetting (no-match precondition)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8',
      );
      // Should query matches table for active match before the reset
      // Pattern: select active matches involving this user, then conditionally
      // reset status. Order matters: match-check must precede the status update.
      const matchCheckIdx = content.indexOf("FROM matches");
      const statusResetIdx = content.search(/status\s+IN\s*\(\s*'disconnected'\s*,\s*'in_round'\s*\)/);
      expect(matchCheckIdx).toBeGreaterThan(-1);
      expect(statusResetIdx).toBeGreaterThan(matchCheckIdx);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Regression — round-lifecycle inline dedup preserved
  // ────────────────────────────────────────────────────────────────────────

  describe('Regression — Bug D round-end dedup preserved', () => {
    it('round-lifecycle.ts still has inline dedup (alreadyRated → ratedUserIds → skip)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/round-lifecycle.ts'),
        'utf8',
      );
      expect(content).toMatch(/alreadyRated|ratedUserIds|ratedUsers/);
      expect(content).toMatch(/SELECT[\s\S]{0,200}from_user_id[\s\S]{0,200}FROM ratings/);
    });
  });
});
