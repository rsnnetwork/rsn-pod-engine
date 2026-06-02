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
      // Phase R4 (20 May 2026): host-check query fires first. user-a is NOT the host.
      dcMockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other-host' }] });
      // Existing rating dedup query — no prior rating.
      dcMockQuery.mockResolvedValueOnce({ rows: [] });

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };
      const payload = { matchId: 'm1', partnerId: 'p1', durationSeconds: 20 };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', payload);

      expect(dcMockQuery).toHaveBeenCalledTimes(2);
      expect(dcMockQuery.mock.calls[0][0]).toMatch(/host_user_id FROM matches/);
      expect(dcMockQuery.mock.calls[1][0]).toMatch(/SELECT id FROM ratings/);
      expect(io.to).toHaveBeenCalledWith('user:user-a');
      expect(emit).toHaveBeenCalledWith('rating:window_open', payload);
    });

    it('skips emit when user has ALREADY rated this match', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      // Host-check: user-a is NOT the host.
      dcMockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'other-host' }] });
      // Ratings dedup: existing rating present.
      dcMockQuery.mockResolvedValueOnce({ rows: [{ id: 'rating-existing' }] });

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', { matchId: 'match-1' });

      expect(dcMockQuery).toHaveBeenCalledTimes(2);
      expect(io.to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits when DB query fails (fail-open — better duplicate prompt than missing one)', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      // Both queries reject — host-check fail-open, then ratings dedup fail-open.
      dcMockQuery.mockRejectedValueOnce(new Error('DB down'));
      dcMockQuery.mockRejectedValueOnce(new Error('DB down'));

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', { matchId: 'match-1' });

      expect(emit).toHaveBeenCalledWith('rating:window_open', { matchId: 'match-1' });
    });

    // Phase R4 (20 May 2026 — live-test post-mortem). The event host must
    // never receive a rating prompt. If they do, an upstream guard (Phase R1)
    // was bypassed and a phantom match was created.
    it('refuses to emit rating:window_open for the event host', async () => {
      const { emitRatingWindowOnce } = await import('../../../services/orchestration/state/session-state');
      // user-a IS the host of the match's session.
      dcMockQuery.mockResolvedValueOnce({ rows: [{ host_user_id: 'user-a' }] });

      const emit = jest.fn();
      const io: any = {
        to: jest.fn(() => ({ emit })),
      };

      await emitRatingWindowOnce(io, 'user-a', 'match-1', { matchId: 'match-1' });

      // Only the host-check query fires; the ratings dedup is short-circuited
      // because the function returns before reaching it.
      expect(dcMockQuery).toHaveBeenCalledTimes(1);
      expect(dcMockQuery.mock.calls[0][0]).toMatch(/host_user_id FROM matches/);
      expect(io.to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
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
    it('participant-flow.ts gates the reset on (disconnected, in_round) for users with no active match', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8',
      );
      // Phase 2B (5 May spec) — the reset was migrated from a raw UPDATE to
      // a transitionParticipant call gated by a JS comparison of the current
      // status. Either form (the legacy SQL `status IN (...)` or the new JS
      // `=== 'disconnected' || === 'in_round'`) satisfies the pin: what
      // matters is that the reset is restricted to those two statuses.
      const sqlForm = /status\s+IN\s*\(\s*'disconnected'\s*,\s*'in_round'\s*\)/;
      const jsForm = /currentStatus\s*===\s*'disconnected'\s*\|\|\s*currentStatus\s*===\s*'in_round'/;
      const matched = sqlForm.test(content) || jsForm.test(content);
      expect(matched).toBe(true);
    });

    it('participant-flow.ts checks for active match before resetting (no-match precondition)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/participant-flow.ts'),
        'utf8',
      );
      // Match-check must precede the conditional reset. Phase 2B replaced the
      // SQL-shaped reset with a JS-shaped one; the precondition still holds —
      // we still query active matches first, then transition only on no-match.
      const matchCheckIdx = content.indexOf("FROM matches");
      const sqlForm = content.search(/status\s+IN\s*\(\s*'disconnected'\s*,\s*'in_round'\s*\)/);
      const jsForm = content.search(/currentStatus\s*===\s*'disconnected'\s*\|\|\s*currentStatus\s*===\s*'in_round'/);
      const resetIdx = sqlForm > -1 ? sqlForm : jsForm;
      expect(matchCheckIdx).toBeGreaterThan(-1);
      expect(resetIdx).toBeGreaterThan(matchCheckIdx);
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
