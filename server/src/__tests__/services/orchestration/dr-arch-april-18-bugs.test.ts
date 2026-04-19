// ─── Dr Arch — April 18 deep audit + fixes ───────────────────────────────
//
// Architectural bugs found during live testing on 2026-04-18:
//
//   Bug 1 — Dashboard wipe on bulk-create error. Root cause: TRIGGER from
//           migration 029 still blocks INSERT when a participant has a
//           non-active match in 'reassigned' or 'completed' state. Bulk-create
//           reassigns existing algorithm matches BEFORE inserting new manual,
//           and trigger then rejects INSERT — leaving algorithm matches
//           reassigned with no replacement. Migration 042 aligns trigger
//           with the (active-only) partial index from migration 041.
//
//   Bug 2 — Video tile small on 1:1 + trio breakouts. Root cause: VideoTile
//           wraps content in `aspect-video` which forces height = width × 9/16.
//           In a `grid-cols-2 h-full` layout, the cell is wide so the tile
//           shrinks to a short strip with empty space below. Fix: when not
//           pinned and inside a flex/grid parent, the tile should fill the
//           cell (h-full + min-h-0), with object-cover handling crop.
//
//   Bug 3 — Match People button enabled in round_active state (when 0 active
//           matches). Disabled rule must include round_active, round_rating,
//           round_transition — independent of active match count.
//
//   Bug 4 — round_active with 0 active matches lingers. Need an auto-transition
//           hook in every match-status transition site that detects this and
//           moves session forward (endRound).

// ESM-style imports so this file is treated as a module and `fs`/`path`
// don't collide with other test files at module scope (TS2451 in CI).
import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, relPath), 'utf8');
}

describe('Dr Arch April 18 — Bug 1: dashboard wipe on bulk-create error', () => {
  it('migration 042 exists and updates trigger to active-only', () => {
    const sql = readSource('../../../db/migrations/042_active_only_uniqueness_trigger.sql');
    // Strip SQL line comments so the assertions check the EXECUTABLE SQL, not
    // the rationale/history we keep in the header.
    const code = sql
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('--'))
      .join('\n');

    // Trigger function recreated to use status = 'active' (active-only check)
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION check_participant_uniqueness_per_round/);
    // The fixed predicate: only block when an OTHER ACTIVE match already has
    // one of the new participants. Reassigned/completed/cancelled/no_show don't block.
    expect(code).toMatch(/m\.status\s*=\s*'active'/);
    // The old broken predicate is gone from the trigger function body.
    expect(code).not.toMatch(/status\s+NOT IN\s*\(\s*'cancelled'\s*,\s*'no_show'\s*\)/);
    // Trigger drop+recreate so existing instances pick up the new function body
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_check_participant_uniqueness ON matches/);
    expect(code).toMatch(/CREATE TRIGGER trg_check_participant_uniqueness/);
  });

  it('breakout-bulk emits dashboard refresh on error path return (not just success)', () => {
    const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
    // The early-return validation paths ALL emit dashboard before returning, so
    // the host UI never holds a stale state from a failed bulk.
    // Look for the signature: an error emit followed by either return or continue
    // with a dashboard emit nearby.
    // At minimum: every `socket.emit('error'` followed by `return` block must
    // eventually emit dashboard before exit. The simplest invariant: the
    // function ends with an unconditional emitHostDashboard.
    const fn = src.slice(
      src.indexOf('export async function handleHostCreateBreakoutBulk'),
      src.indexOf('export async function handleHostExtendBreakoutAll'),
    );
    expect(fn).toMatch(/_emitHostDashboard/);
  });

  it('handleHostCreateBreakout (single) emits dashboard on PARTICIPANT_ALREADY_MATCHED early return', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostCreateBreakout');
    expect(fnStart).toBeGreaterThan(-1);
    const nextExport = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);

    // The PARTICIPANT_ALREADY_MATCHED error path must emit dashboard before
    // returning so the client doesn't hold stale state.
    // Find the catch block for the failed INSERT.
    const insertCatchIdx = fn.indexOf('PARTICIPANT_ALREADY_MATCHED');
    expect(insertCatchIdx).toBeGreaterThan(-1);
    // Look at the nearby block (within 1500 chars) — it must contain a
    // _emitHostDashboard call (either inline or after the early return).
    const nearBlock = fn.slice(insertCatchIdx - 200, insertCatchIdx + 1200);
    expect(nearBlock).toMatch(/_emitHostDashboard/);
  });
});

describe('Dr Arch April 18 — Bug 2: 1:1 + trio breakout tiles fill available space', () => {
  let videoRoomSrc = '';
  beforeAll(() => {
    videoRoomSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
  });

  it('desktop 1:1 grid cells are h-full + flex-center so VideoTile fills cell vertically', () => {
    // Bug 6.5 (April 19): each grid cell now uses
    // `h-full flex items-center justify-center cursor-pointer` so the inner
    // 16:9-capped tile centers vertically inside the row. Previously the
    // cell was just `h-full cursor-pointer` and the tile filled the entire
    // cell — nearly square on a wide desktop, causing huge bottom black bar
    // when source video was landscape 16:9.
    const desktopGridIdx = videoRoomSrc.indexOf("hidden md:grid h-full");
    expect(desktopGridIdx).toBeGreaterThan(-1);
    const block = videoRoomSrc.slice(desktopGridIdx, desktopGridIdx + 1800);
    // Cells must include h-full AND flex-center so the inner 16:9 wrapper
    // can center vertically. Allow the markers in any order on the className.
    const cellMatches = (block.match(/className="h-full flex items-center justify-center cursor-pointer"/g) || []).length;
    expect(cellMatches).toBeGreaterThanOrEqual(2);
    // The inner 16:9 wrapper is what holds the actual VideoTile. Verify it
    // exists (aspectRatio inline style + maxHeight: 100%).
    expect(block).toMatch(/aspectRatio:\s*['"]16\s*\/\s*9['"][\s\S]*?maxHeight:\s*['"]100%['"]/);
  });

  it('VideoTile applies h-full w-full when not pinned (replaces aspect-video collapse)', () => {
    // The VideoTile component must expand to fill its parent container when
    // not pinned (so grid cells / flex cells with h-full children work).
    // We assert the non-pinned class string includes h-full w-full (or the
    // tile's wrapper now uses flex-1 min-h-0 / equivalent fill mechanism).
    // Specifically: the `${isPinned ? 'h-full w-full' : 'aspect-video'}` ternary
    // is replaced with one that fills the parent when not pinned.
    const nonPinnedFillRegex = /isPinned\s*\?\s*['"`][^'"`]*h-full w-full[^'"`]*['"`]\s*:\s*['"`][^'"`]*h-full w-full/;
    expect(videoRoomSrc).toMatch(nonPinnedFillRegex);
  });

  it('mobile 1:1 partner tile keeps full screen fill (h-full)', () => {
    // The mobile 1:1 path wraps the partner VideoTile in `h-full cursor-pointer`.
    // Assert this marker is preserved (it's load-bearing for the FaceTime layout).
    expect(videoRoomSrc).toMatch(/md:hidden h-full relative[\s\S]{0,400}h-full cursor-pointer/);
  });

  it('VideoTrack className supports both contain (default) and cover (PIP) — Bug 6 + Bug 16', () => {
    // Bug 6 (April 18 r2): default to object-contain so portrait phone
    // video on landscape desktop tiles isn't aggressively cropped.
    // Bug 16 (April 19): PIP self-view opts into object-cover because
    // portrait video in a small portrait container looks too small with
    // contain (visible side bars). VideoTile now picks via fillMode prop.
    const videoTrackBlocks = videoRoomSrc.match(/<VideoTrack[\s\S]*?\/>/g) || [];
    expect(videoTrackBlocks.length).toBeGreaterThan(0);
    for (const block of videoTrackBlocks) {
      expect(block).toMatch(/fillMode\s*===\s*['"]contain['"][\s\S]*object-contain[\s\S]*object-cover/);
    }
  });
});

describe('Dr Arch April 18 — Bug 5: Round controls + Match People derive from live algorithm-match state', () => {
  let hostControlsSrc = '';
  beforeAll(() => {
    hostControlsSrc = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/HostControls.tsx'),
      'utf8',
    );
  });

  // Bug 5 supersedes Bug 3. The earlier "disable on round_active OR round_rating
  // OR round_transition" rule was wrong: handleHostGenerateMatches explicitly
  // accepts ROUND_TRANSITION (matching-flow.ts:60-69), so the client was
  // blocking a legitimate path. The new rule is purely live-state-derived.

  it('hasActiveAlgorithmRound derived from roundDashboard.rooms (status=active && !isManual)', () => {
    // The single source of truth for both Match People disable AND
    // Pause/+2/End Round visibility.
    expect(hostControlsSrc).toMatch(/hasActiveAlgorithmRound/);
    // Find the const declaration (skip comment-only mentions).
    const declIdx = hostControlsSrc.indexOf('const hasActiveAlgorithmRound');
    expect(declIdx).toBeGreaterThan(-1);
    const block = hostControlsSrc.slice(declIdx, declIdx + 400);
    expect(block).toMatch(/r\.status\s*===\s*'active'/);
    expect(block).toMatch(/!r\.isManual/);
  });

  it('matchPeopleDisabled uses hasActiveAlgorithmRound (NOT session.status round_transition)', () => {
    const idx = hostControlsSrc.indexOf('matchPeopleDisabled');
    expect(idx).toBeGreaterThan(-1);
    const block = hostControlsSrc.slice(idx, idx + 400);
    expect(block).toMatch(/hasActiveAlgorithmRound/);
    expect(block).toMatch(/eligibleMainRoomCount\s*<\s*2/);
    // The old over-aggressive rule that disabled on round_transition is gone.
    expect(block).not.toMatch(/sessionStatus\s*===\s*'round_transition'/);
  });

  it('Pause / +2 min / End Round visibility derived from hasActiveAlgorithmRound', () => {
    // All three controls must show whenever an algorithm round is live —
    // they used to be gated on sessionStatus === 'round_active' which
    // hid them during transitional / mismatched states.
    const pauseBlock = hostControlsSrc.match(/Pause\/Resume during round[\s\S]{0,800}/)?.[0] || '';
    expect(pauseBlock).toMatch(/hasActiveAlgorithmRound/);
    const extendBlock = hostControlsSrc.match(/Extend round by 2 minutes[\s\S]{0,800}/)?.[0] || '';
    expect(extendBlock).toMatch(/hasActiveAlgorithmRound/);
    const endRoundBlock = hostControlsSrc.match(/End current round early[\s\S]{0,800}/)?.[0] || '';
    expect(endRoundBlock).toMatch(/hasActiveAlgorithmRound/);
  });

  it('hint message reads "wait for it to end" (live state, not future-tense)', () => {
    // The new copy is honest about current state — there's an active round
    // right now, wait for it to end. Old copy "next round" was forward-looking
    // and confusing in the round_transition state.
    const idx = hostControlsSrc.indexOf('matchPeopleHint');
    expect(idx).toBeGreaterThan(-1);
    const block = hostControlsSrc.slice(idx, idx + 600);
    expect(block).toMatch(/wait for it to end/i);
  });
});

describe('Dr Arch April 18 — Bug 4: round_active with 0 active matches auto-transitions', () => {
  it('round-lifecycle exports maybeAutoEndEmptyRound helper', async () => {
    const mod: any = await import('../../../services/orchestration/handlers/round-lifecycle');
    expect(typeof mod.maybeAutoEndEmptyRound).toBe('function');
  });

  it('helper queries active matches in current round and triggers endRound on zero', () => {
    const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
    // The exported helper must guard on session.status === ROUND_ACTIVE and
    // count active matches for currentRound. If zero → call endRound.
    const fnStart = src.indexOf('export async function maybeAutoEndEmptyRound');
    expect(fnStart).toBeGreaterThan(-1);
    const nextExport = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
    // Guards: only act when session is in ROUND_ACTIVE
    expect(fn).toMatch(/SessionStatus\.ROUND_ACTIVE|status\s*===\s*'?round_active'?/);
    // Count active matches
    expect(fn).toMatch(/SELECT[\s\S]*COUNT[\s\S]*FROM matches/i);
    // status='active' filter
    expect(fn).toMatch(/status\s*=\s*'active'/);
    // round_number = current
    expect(fn).toMatch(/round_number/);
    // Calls endRound when zero
    expect(fn).toMatch(/endRound\(/);
  });

  it('participant-flow handleLeaveConversation calls maybeAutoEndEmptyRound after status transition', () => {
    const src = readSource('../../../services/orchestration/handlers/participant-flow.ts');
    // After the UPDATE matches SET status = 'completed' in handleLeaveConversation
    // we need the auto-transition check.
    expect(src).toMatch(/maybeAutoEndEmptyRound/);
  });

  it('host-actions handleHostRemoveFromRoom calls maybeAutoEndEmptyRound after status transition', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    // Match-end via host removal must trigger the check.
    expect(src).toMatch(/maybeAutoEndEmptyRound/);
  });

  it('host-actions handleHostMoveToRoom calls maybeAutoEndEmptyRound', () => {
    const src = readSource('../../../services/orchestration/handlers/host-actions.ts');
    // Move-to-room ends the source match. If that was the last active match
    // in the round, we must transition.
    const fnStart = src.indexOf('export async function handleHostMoveToRoom');
    expect(fnStart).toBeGreaterThan(-1);
    const nextExport = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
    // Must reference the helper somewhere in this function (or its tail).
    expect(fn).toMatch(/maybeAutoEndEmptyRound/);
  });

  it('round-lifecycle detectNoShows triggers maybeAutoEndEmptyRound when all matches no-show', () => {
    const src = readSource('../../../services/orchestration/handlers/round-lifecycle.ts');
    // After any anyTransition in detectNoShows, we may have ended every match.
    const fnStart = src.indexOf('export async function detectNoShows');
    const nextExport = src.indexOf('\nexport', fnStart + 30);
    const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
    expect(fn).toMatch(/maybeAutoEndEmptyRound/);
  });
});

describe('Dr Arch April 18 — Bug 4: maybeAutoEndEmptyRound runtime behavior', () => {
  // Functional test: stand up a session in ROUND_ACTIVE with 0 active matches
  // and assert maybeAutoEndEmptyRound triggers endRound (which fires
  // session:status_changed with ROUND_RATING).

  beforeEach(() => {
    jest.resetModules();
  });

  it('does nothing when session is not in ROUND_ACTIVE', async () => {
    jest.doMock('../../../db', () => ({
      query: jest.fn().mockResolvedValue({ rows: [{ c: '0' }], rowCount: 1 }),
      transaction: jest.fn(),
      __esModule: true,
    }));
    jest.doMock('../../../config/logger', () => ({
      default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
      __esModule: true,
    }));

    const { maybeAutoEndEmptyRound } = await import('../../../services/orchestration/handlers/round-lifecycle');
    const { activeSessions } = await import('../../../services/orchestration/state/session-state');
    const { SessionStatus } = await import('@rsn/shared');

    activeSessions.set('test-session-not-active', {
      sessionId: 'test-session-not-active',
      hostUserId: 'host-1',
      config: { numberOfRounds: 5, roundDurationSeconds: 480, ratingWindowSeconds: 30, noShowTimeoutSeconds: 30 } as any,
      currentRound: 1,
      status: SessionStatus.LOBBY_OPEN,
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: null,
      isPaused: false,
      pausedTimeRemaining: null,
      pendingRoundNumber: null,
      presenceMap: new Map(),
      manuallyLeftRound: new Set(),
    });

    const io: any = { to: () => ({ emit: jest.fn() }) };

    // Should NOT throw and NOT call any session-mutating queries since status
    // is LOBBY_OPEN (the helper short-circuits).
    await expect(maybeAutoEndEmptyRound(io as any, 'test-session-not-active')).resolves.toBeUndefined();

    activeSessions.delete('test-session-not-active');
  });

  it('does nothing when session is unknown (no activeSession entry)', async () => {
    const { maybeAutoEndEmptyRound } = await import('../../../services/orchestration/handlers/round-lifecycle');
    const io: any = { to: () => ({ emit: jest.fn() }) };
    await expect(maybeAutoEndEmptyRound(io as any, 'nonexistent-session')).resolves.toBeUndefined();
  });
});

describe('Dr Arch April 18 — preserves prior fixes (regression guard)', () => {
  it('migration 041 active-only partial unique index still in place', () => {
    const sql = readSource('../../../db/migrations/041_active_only_match_uniqueness.sql');
    expect(sql).toMatch(/WHERE status\s*=\s*'active'/);
  });

  it('migration 040 is_manual column still present', () => {
    const sql = readSource('../../../db/migrations/040_matches_is_manual.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_manual/);
  });

  it('breakout-bulk still uses is_manual=TRUE column for filtering manual rooms', () => {
    const src = readSource('../../../services/orchestration/handlers/breakout-bulk.ts');
    expect(src).toMatch(/is_manual\s*=\s*TRUE/);
  });

  it('match-status: no_show only written by detectNoShows (Change 4.6)', () => {
    const phsrc = readSource('../../../services/orchestration/handlers/participant-flow.ts');
    const hasrc = readSource('../../../services/orchestration/handlers/host-actions.ts');
    expect((phsrc.match(/status\s*=\s*'no_show'/g) || []).length).toBe(0);
    expect((hasrc.match(/status\s*=\s*'no_show'/g) || []).length).toBe(0);
  });

  it('clearRoomTimers still exported (Change 4.5 ghost-timer fix)', async () => {
    const mod: any = await import('../../../services/orchestration/handlers/host-actions');
    expect(typeof mod.clearRoomTimers).toBe('function');
  });
});
