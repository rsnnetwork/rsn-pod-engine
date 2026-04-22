// Tests for Task 14 — bulk manual breakout room handlers.
//
// Covers:
//   - Handler exports
//   - Migration 039 shape
//   - Socket registration in orchestration.service
//   - Non-host guard rejects
//   - Core behaviors with mocked dependencies

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
const mockUpdateParticipantStatus = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  updateParticipantStatus: (...args: unknown[]) => mockUpdateParticipantStatus(...args),
  __esModule: true,
}));

const mockCreateMatchRoom = jest.fn().mockResolvedValue(undefined);
const mockMatchRoomId = jest.fn((sid: string, rn: number, slug: string) => `${sid}-r${rn}-${slug}`);
const mockIssueJoinToken = jest.fn().mockResolvedValue({ token: 'tok', url: 'wss://test' });
const mockGetVideoProvider = jest.fn(() => ({ closeRoom: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/video/video.service', () => ({
  createMatchRoom: (...args: unknown[]) => mockCreateMatchRoom(...args),
  matchRoomId: (...args: unknown[]) => mockMatchRoomId(...(args as [string, number, string])),
  issueJoinToken: (...args: unknown[]) => mockIssueJoinToken(...args),
  getVideoProvider: () => mockGetVideoProvider(),
  __esModule: true,
}));

jest.mock('../../../config', () => ({
  config: { livekit: { host: 'wss://test-livekit' } },
  __esModule: true,
}));

describe('Task 14 — bulk manual breakout handlers', () => {
  describe('migration 039 — timer_visibility column', () => {
    it('migration file exists and adds timer_visibility column with CHECK constraint', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const sql = fs.readFileSync(
        path.join(__dirname, '../../../db/migrations/039_breakout_timer_visibility.sql'),
        'utf8',
      );
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS timer_visibility/);
      expect(sql).toMatch(/DEFAULT 'visible'/);
      expect(sql).toMatch(/CHECK \(timer_visibility IN \('visible', 'hidden'\)\)/);
    });
  });

  describe('handler exports', () => {
    it('exports all 4 bulk handlers', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      expect(typeof mod.handleHostCreateBreakoutBulk).toBe('function');
      expect(typeof mod.handleHostExtendBreakoutAll).toBe('function');
      expect(typeof mod.handleHostEndBreakoutAll).toBe('function');
      expect(typeof mod.handleHostSetBreakoutDurationAll).toBe('function');
      expect(typeof mod.injectBreakoutBulkDeps).toBe('function');
    });
  });

  describe('socket event registration in orchestration.service', () => {
    it('registers all 4 bulk socket events', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/orchestration.service.ts'),
        'utf8',
      );
      expect(content).toMatch(/host:create_breakout_bulk/);
      expect(content).toMatch(/host:extend_breakout_all/);
      expect(content).toMatch(/host:end_breakout_all/);
      expect(content).toMatch(/host:set_breakout_duration_all/);
      // Each event must be registered via wrapHandler (error-guarded)
      expect(content).toMatch(/wrapHandler\('host:create_breakout_bulk'/);
      expect(content).toMatch(/wrapHandler\('host:extend_breakout_all'/);
      expect(content).toMatch(/wrapHandler\('host:end_breakout_all'/);
      expect(content).toMatch(/wrapHandler\('host:set_breakout_duration_all'/);
    });
  });

  describe('functional — non-host guard rejects', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Default: query returns empty rows (no cohosts, no manual rooms)
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    it('handleHostCreateBreakoutBulk rejects non-host with UNAUTHORIZED/FORBIDDEN emit', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({
        id: 'sess-1', hostUserId: 'real-host',
      });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'imposter', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };

      const io: any = {
        to: () => ({ emit: jest.fn() }),
      };

      await mod.handleHostCreateBreakoutBulk(io, socket, {
        sessionId: 'sess-1',
        rooms: [{ participantIds: ['u1'] }],
        sharedDurationSeconds: 300,
        timerVisibility: 'visible',
      });

      // Should emit an error (UNAUTHORIZED or FORBIDDEN from verifyHost)
      const errorEmits = emits.filter(e => e.event === 'error');
      expect(errorEmits.length).toBeGreaterThan(0);
      expect(errorEmits[0].payload.code).toMatch(/UNAUTHORIZED|FORBIDDEN/);

      // No match was created
      expect(mockCreateMatchRoom).not.toHaveBeenCalled();
    });

    it('handleHostExtendBreakoutAll rejects non-host', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({
        id: 'sess-1', hostUserId: 'real-host',
      });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'imposter', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };

      const io: any = { to: () => ({ emit: jest.fn() }) };

      await mod.handleHostExtendBreakoutAll(io, socket, {
        sessionId: 'sess-1', additionalSeconds: 120,
      });

      expect(emits.some(e => e.event === 'error')).toBe(true);
    });

    it('handleHostEndBreakoutAll rejects non-host', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({
        id: 'sess-1', hostUserId: 'real-host',
      });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'imposter', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };

      const io: any = { to: () => ({ emit: jest.fn() }) };

      await mod.handleHostEndBreakoutAll(io, socket, { sessionId: 'sess-1' });

      expect(emits.some(e => e.event === 'error')).toBe(true);
      // No match UPDATE or SELECT for active-manual-rooms fired
      const updateCalls = mockQuery.mock.calls.filter(args =>
        /UPDATE matches|SELECT .* FROM matches/i.test(String(args[0])),
      );
      expect(updateCalls.length).toBe(0);
    });

    it('handleHostSetBreakoutDurationAll rejects non-host', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({
        id: 'sess-1', hostUserId: 'real-host',
      });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'imposter', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };

      const io: any = { to: () => ({ emit: jest.fn() }) };

      await mod.handleHostSetBreakoutDurationAll(io, socket, {
        sessionId: 'sess-1', durationSeconds: 600,
      });

      expect(emits.some(e => e.event === 'error')).toBe(true);
    });
  });

  describe('functional — validation errors', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // T1-5 — verifyHost now uses canActAsHost → getEffectiveRole, which
      // queries sessions/host_user_id directly. Default mock makes the
      // calling user a recognised host so validation paths still run.
      mockQuery.mockImplementation((sql: string) => {
        if (/SELECT host_user_id FROM sessions/i.test(sql)) {
          return Promise.resolve({ rows: [{ host_user_id: 'host-1' }], rowCount: 1 });
        }
        if (/SELECT pod_id FROM sessions/i.test(sql)) {
          return Promise.resolve({ rows: [{ pod_id: null }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    });

    it('rejects bulk create with empty rooms array', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({ id: 'sess-1', hostUserId: 'host-1' });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'host-1', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };
      const io: any = { to: () => ({ emit: jest.fn() }) };

      await mod.handleHostCreateBreakoutBulk(io, socket, {
        sessionId: 'sess-1', rooms: [], sharedDurationSeconds: 300,
      });

      const errs = emits.filter(e => e.event === 'error');
      expect(errs.some(e => /required|at least/i.test(e.payload.message))).toBe(true);
    });

    it('rejects bulk create when a participant appears in two rooms', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/breakout-bulk');
      mockGetSessionById.mockResolvedValue({ id: 'sess-1', hostUserId: 'host-1' });

      const emits: Array<{ event: string; payload: any }> = [];
      const socket: any = {
        data: { userId: 'host-1', role: 'user' },
        emit: (event: string, payload: any) => emits.push({ event, payload }),
      };
      const io: any = { to: () => ({ emit: jest.fn() }) };

      await mod.handleHostCreateBreakoutBulk(io, socket, {
        sessionId: 'sess-1',
        rooms: [
          { participantIds: ['u1', 'u2'] },
          { participantIds: ['u2', 'u3'] }, // u2 duplicated
        ],
        sharedDurationSeconds: 300,
      });

      const errs = emits.filter(e => e.event === 'error');
      expect(errs.some(e => /two bulk rooms/i.test(e.payload.message))).toBe(true);
    });
  });

  describe('preservation — Change 4.5 + 4.6 behaviors', () => {
    it('uses timer_visibility column when inserting match (migration 039)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      expect(content).toMatch(/timer_visibility/);
      // INSERT statement writes timer_visibility
      expect(content).toMatch(/INSERT INTO matches[\s\S]*timer_visibility/);
    });

    it('uses status=completed on bulk end (Change 4.6 semantics)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      // Bulk end writes completed, never no_show
      expect(content).toMatch(/status\s*=\s*'completed'/);
      expect(content).not.toMatch(/status\s*=\s*'no_show'/);
    });

    it('reuses clearRoomTimers + roomTimers map (Change 4.5 ghost-timer fix)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      // Shares state + uses clearRoomTimers
      expect(content).toMatch(/clearRoomTimers/);
      expect(content).toMatch(/roomTimers,\s*roomSyncIntervals/);
    });

    it('only targets MANUAL rooms — is_manual = TRUE (migration 040)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      // Replaces the old brittle room_id LIKE pattern with the canonical
      // is_manual column added in migration 040.
      expect(content).toMatch(/is_manual\s*=\s*TRUE/);
    });

    it('host-actions still exports roomTimers/roomSyncIntervals/RoomTimerState for bulk module', async () => {
      const mod: any = await import('../../../services/orchestration/handlers/host-actions');
      expect(mod.roomTimers).toBeInstanceOf(Map);
      expect(mod.roomSyncIntervals).toBeInstanceOf(Map);
      expect(typeof mod.clearRoomTimers).toBe('function');
    });
  });

  describe('match:reassigned payload includes timerVisibility', () => {
    it('source emits timerVisibility in match:reassigned payload', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      // match:reassigned emit must include timerVisibility
      expect(content).toMatch(/match:reassigned[\s\S]{0,800}timerVisibility/);
    });
  });

  describe('migration 040 + is_manual column', () => {
    it('migration 040 file exists and adds is_manual column with backfill', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const sql = fs.readFileSync(
        path.join(__dirname, '../../../db/migrations/040_matches_is_manual.sql'),
        'utf8',
      );
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_manual BOOLEAN/);
      expect(sql).toMatch(/DEFAULT FALSE/);
      // Backfill from existing room_id pattern (Change 4.5 convention)
      expect(sql).toMatch(/UPDATE matches[\s\S]*SET is_manual = TRUE[\s\S]*WHERE room_id LIKE/);
      // Index for filtering performance
      expect(sql).toMatch(/CREATE INDEX[\s\S]*idx_matches_session_round_is_manual/);
    });

    it('bulk-create INSERT writes is_manual = TRUE', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      // INSERT statement must mention is_manual with TRUE
      expect(content).toMatch(/INSERT INTO matches[\s\S]*is_manual[\s\S]*TRUE/);
    });

    it('host-actions handleHostCreateBreakout writes is_manual = TRUE', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );
      expect(content).toMatch(/INSERT INTO matches[\s\S]*is_manual[\s\S]*TRUE/);
    });

    it('PARTICIPANT_ALREADY_MATCHED is emitted on constraint violation in single-room create', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );
      expect(content).toMatch(/PARTICIPANT_ALREADY_MATCHED/);
    });

    it('PARTICIPANT_ALREADY_MATCHED is emitted on constraint violation in bulk create', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/breakout-bulk.ts'),
        'utf8',
      );
      expect(content).toMatch(/PARTICIPANT_ALREADY_MATCHED/);
    });
  });

  describe('matching-flow: algorithm exclusion ignores manual matches', () => {
    it('matching.service.ts excluded-pairs query has AND is_manual = FALSE', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/matching/matching.service.ts'),
        'utf8',
      );
      // Algorithm "already matched" set must NOT include manual breakout pairs
      expect(content).toMatch(/excluded[\s\S]*is_manual\s*=\s*FALSE/i);
    });

    it('matching.service.ts getEligibleParticipants is exported', async () => {
      const mod: any = await import('../../../services/matching/matching.service');
      expect(typeof mod.getEligibleParticipants).toBe('function');
    });

    it('matching.service.ts eligible-participants query excludes users in active matches', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/matching/matching.service.ts'),
        'utf8',
      );
      // generateSingleRound + getEligibleParticipants both filter via NOT EXISTS subquery
      expect(content).toMatch(/NOT EXISTS[\s\S]*FROM matches[\s\S]*status\s*=\s*'active'/);
    });

    it('matching-flow handleHostGenerateMatches emits INSUFFICIENT_PARTICIPANTS guard', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'),
        'utf8',
      );
      expect(content).toMatch(/INSUFFICIENT_PARTICIPANTS/);
      expect(content).toMatch(/getEligibleParticipants/);
    });

    it('matching-flow handleHostGenerateMatches emits NO_ELIGIBLE_PAIRS guard on zero pairs', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'),
        'utf8',
      );
      expect(content).toMatch(/NO_ELIGIBLE_PAIRS/);
    });

    it('emitHostDashboard payload includes eligibleMainRoomCount', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'),
        'utf8',
      );
      expect(content).toMatch(/eligibleMainRoomCount/);
    });

    it('emitHostDashboard isManual reads from m.isManual column (not roomId pattern)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/matching-flow.ts'),
        'utf8',
      );
      // Must read from the m.isManual column (not the brittle roomId LIKE
      // pattern). Bug 18 (April 19) refactored the room-mapping closure
      // to compute `const isManual = m.isManual === true;` once and use
      // shorthand `{ isManual }` in the dashboard payload — same source,
      // different surface form. Accept either pattern.
      expect(content).toMatch(/m\.isManual\s*===\s*true|isManual:\s*m\.isManual/);
    });
  });
});
