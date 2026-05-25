// 25 May live-test fixes (Ali). See docs/superpowers/plans/2026-05-25-live-test-investigation.md
//   A — return re-registers via session:join (recovery; revert of heartbeat-only)
//   C — rating skip recorded server-side + honored by replay & endRound dedup
//   B — in-breakout users excluded from the main-room tile list
//   F/G — timer:sync scoped to context (round vs breakout); client ignores cross-context ticks
//   H — non-destructive participant refetch (no blank-then-repopulate glimpse)
//   D — LiveKit video re-init on return to foreground

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}
function fnSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\nexport ', start + 1));
}

describe('25 May live-test fixes', () => {
  describe('A — return re-registers via session:join', () => {
    it('foreground resync emits session:join (not heartbeat-only)', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      const i = src.indexOf('resyncPresenceOnReturn =');
      expect(i).toBeGreaterThan(-1);
      expect(src.slice(i, i + 1000)).toMatch(/emit\(\s*['"]session:join/);
    });
  });

  describe('F — manual-room timers cleared on event end (no cross-event leak)', () => {
    it('completeSession clears room timers for the session matches', () => {
      const fn = fnSlice(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function completeSession');
      expect(fn).toMatch(/clearRoomTimers/);
      expect(fn).toMatch(/FROM matches WHERE session_id/);
    });
  });

  describe('C — rating skip recorded + honored', () => {
    const pfSrc = readServer('services/orchestration/handlers/participant-flow.ts');

    it('handleRatingSkip records the skip on the session', () => {
      expect(pfSrc).toMatch(/export async function handleRatingSkip/);
      expect(pfSrc).toMatch(/ratingSkips[\s\S]{0,80}\.add\(/);
    });
    it('rating-replay does not re-send when the user skipped this match', () => {
      expect(pfSrc).toMatch(/ratingSkips\?\.has\([\s\S]{0,40}userMatch\.id/);
    });
    it('endRound dedup honors ratingSkips', () => {
      const fn = fnSlice(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function endRound');
      expect(fn).toMatch(/ratingSkips\?\.has\([\s\S]{0,30}match\.id/);
    });
    it('rating:skip is wired server-side and emitted by RatingPrompt on Skip', () => {
      expect(readServer('services/orchestration/orchestration.service.ts')).toMatch(/wrapHandler\('rating:skip'/);
      expect(readClient('features/live/RatingPrompt.tsx')).toMatch(/emit\('rating:skip'/);
    });
  });

  describe('I — EVENT PLAN strip ignores manual breakout matches', () => {
    // A manual room created after a round ended inherits that round_number and is
    // status='active', which was flipping the round chip back to amber "Active".
    const src = readServer('routes/sessions.ts');
    const planFn = src.slice(src.indexOf("'/:id/plan'"));
    it('the per-round status query excludes manual matches', () => {
      // matchesResult (round status + pairCount) must filter is_manual.
      expect(planFn).toMatch(/GROUP BY round_number, status/);
      const statusQ = planFn.slice(0, planFn.indexOf('GROUP BY round_number, status'));
      expect(statusQ).toMatch(/COALESCE\(is_manual, FALSE\) = FALSE/);
    });
    it('the bye-count round source excludes manual matches', () => {
      expect(planFn).toMatch(/round_participants AS[\s\S]{0,400}COALESCE\(m\.is_manual, FALSE\) = FALSE/);
    });
  });

  describe('F/G — timer:sync scoped to context (self-healing breakout ownership)', () => {
    it('every per-user (breakout) timer:sync is tagged segmentType "breakout"', () => {
      // Session timers use sessionRoom(...) + a session-status segmentType; manual
      // room timers use userRoom(pid) and MUST carry segmentType 'breakout' so the
      // client can tell them apart. No per-user emit may go out untagged.
      for (const f of [
        'services/orchestration/handlers/breakout-bulk.ts',
        'services/orchestration/handlers/host-actions.ts',
      ]) {
        const src = readServer(f);
        expect(src).not.toMatch(/userRoom\([^)]*\)\)\.emit\('timer:sync', \{ secondsRemaining/);
      }
    });
    it('manual match:reassigned carries isManual:true', () => {
      const src = readServer('services/orchestration/handlers/breakout-bulk.ts');
      expect(src).toMatch(/emit\('match:reassigned', \{[\s\S]{0,800}isManual: true/);
    });
    it('client gates session timer:sync on breakout-sync recency (no flag to lose on refresh)', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      expect(src).toMatch(/lastBreakoutSyncRef/);
      expect(src).toMatch(/BREAKOUT_OWNERSHIP_MS/);
      const i = src.indexOf("socket.on('timer:sync'");
      expect(i).toBeGreaterThan(-1);
      const body = src.slice(i, i + 2600);
      expect(body).toMatch(/data\.segmentType === 'breakout'/);
      expect(body).toMatch(/lastBreakoutSyncRef\.current < BREAKOUT_OWNERSHIP_MS/);
    });
    it('breakout ownership is released the instant the user leaves the breakout', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      const rw = src.indexOf("socket.on('rating:window_open'");
      expect(src.slice(rw, rw + 1200)).toMatch(/lastBreakoutSyncRef\.current = 0/);
      const rl = src.indexOf("socket.on('match:return_to_lobby'");
      expect(src.slice(rl, rl + 600)).toMatch(/lastBreakoutSyncRef\.current = 0/);
    });
    it('rating:window_open clears the timer and nulls timerEndsAt (no rating countdown shown)', () => {
      // B (26 May) — the rating window has no visible countdown. On window_open we
      // stop the 1s tick (clearTimer) and null out timerEndsAt so the recompute
      // path never drives a display during rating. The previous fix set timerEndsAt
      // to suppress stale-breakout flicker; that flicker is now moot because the
      // rating phase renders no timer at all.
      const src = readClient('hooks/useSessionSocket.ts');
      const rw = src.indexOf("socket.on('rating:window_open'");
      const body = src.slice(rw, rw + 2400);
      expect(body).toMatch(/clearTimer\(\)/);
      expect(body).toMatch(/setTimerEndsAt\(null\)/);
      // Must NOT start a new countdown interval for the rating phase
      expect(body).not.toMatch(/intervalRef\.current = setInterval[\s\S]{0,40}tickTimer/);
    });
  });

  describe('J — End-all-rooms button on the manual-rooms panel', () => {
    const src = readClient('features/live/HostRoundDashboard.tsx');
    it('has an end-all handler emitting host:end_breakout_all', () => {
      expect(src).toMatch(/endAllManualRooms/);
      expect(src).toMatch(/emit\('host:end_breakout_all'/);
    });
    it('renders an "End all rooms" button', () => {
      expect(src).toMatch(/End all rooms/);
    });
  });

  describe('D — LiveKit reconnect on return to foreground', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    it('imports the room-context + connection-state primitives', () => {
      expect(src).toMatch(/useRoomContext/);
      expect(src).toMatch(/ConnectionState/);
    });
    it('ReconnectOnReturn fires only on a hard Disconnected state, on return/online', () => {
      const i = src.indexOf('function ReconnectOnReturn');
      expect(i).toBeGreaterThan(-1);
      const body = src.slice(i, i + 1200);
      expect(body).toMatch(/room\.state !== ConnectionState\.Disconnected\) return/);
      expect(body).toMatch(/visibilitychange/);
      expect(body).toMatch(/addEventListener\('online'/);
      expect(body).toMatch(/debounceRef/);
    });
    it('reconnect refreshes a clean attempt and is gated to the matched phase', () => {
      const i = src.indexOf('const reconnectRoom');
      expect(i).toBeGreaterThan(-1);
      const body = src.slice(i, i + 400);
      expect(body).toMatch(/phase !== 'matched'\) return/);
      expect(body).toMatch(/retryCountRef\.current = 0/);
      expect(body).toMatch(/setLiveKitToken\(null, null\)/);
    });
    it('a successful connect resets the retry budget (no permanent kick over a long event)', () => {
      const i = src.indexOf('onConnected={');
      expect(src.slice(i, i + 900)).toMatch(/retryCountRef\.current = 0/);
    });
    it('ReconnectOnReturn is mounted inside the LiveKitRoom', () => {
      expect(src).toMatch(/<ReconnectOnReturn onReconnect=\{reconnectRoom\}/);
    });
  });

  describe('B (26 May) — rating-window backstop and no client countdown', () => {
    it('endRound uses a plain setTimeout backstop (no startSegmentTimer for rating)', () => {
      const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
      const fn = fnSlice(src, 'export async function endRound');
      // The rating backstop must NOT call startSegmentTimer — that would broadcast timer:sync
      expect(fn).not.toMatch(/startSegmentTimer[\s\S]{0,60}endRatingWindow/);
      // It must use a plain setTimeout storing on activeSession.timer
      expect(fn).toMatch(/activeSession\.timer = setTimeout/);
      expect(fn).toMatch(/endRatingWindow/);
    });
    it('backstop is fixed at 180 000 ms (generous, non-disruptive)', () => {
      const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
      expect(src).toMatch(/RATING_BACKSTOP_MS\s*=\s*180_000/);
    });
    it('backstop uses clearSessionTimers before arming so prior timers do not leak', () => {
      const src = readServer('services/orchestration/handlers/round-lifecycle.ts');
      const fn = fnSlice(src, 'export async function endRound');
      expect(fn).toMatch(/clearSessionTimers\(sessionId\)/);
    });
    it('all-rated early-close (checkAllRatingsCompleteByUserId) is untouched', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      expect(src).toMatch(/checkAllRatingsCompleteByUserId/);
      expect(src).toMatch(/All ratings submitted — ending rating window early/);
      // Still clears the timer before scheduling the 3s grace
      expect(src).toMatch(/activeSession\.timer\s*=\s*null/);
    });
    it('RatingPrompt has no countdown display (no Clock import, no timerSeconds)', () => {
      const src = readClient('features/live/RatingPrompt.tsx');
      expect(src).not.toMatch(/import.*Clock.*from 'lucide-react'/);
      expect(src).not.toMatch(/timerSeconds/);
    });
    it('client fallback returns-to-lobby after generous fixed 210s (backstop 180s + 30s grace)', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      const rw = src.indexOf("socket.on('rating:window_open'");
      const body = src.slice(rw, rw + 2400);
      expect(body).toMatch(/210_000/);
      expect(body).not.toMatch(/durationSeconds.*\+\s*30.*\*\s*1000/);
    });
  });

  describe('round-rating / pulled-out fixes (25 May pm)', () => {
    it('#1 — a rater ignores the session segment broadcast (per-user rating window is authoritative)', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      const i = src.indexOf("socket.on('timer:sync'");
      expect(i).toBeGreaterThan(-1);
      expect(src.slice(i, i + 3600)).toMatch(/state\.phase === 'rating' && data\.segmentType && data\.segmentType !== 'breakout'/);
    });
    it('#2 — RatingPrompt records lastRatedRound on the last-partner submit (no re-prompt mid-confirmation)', () => {
      const src = readClient('features/live/RatingPrompt.tsx');
      const i = src.indexOf('const handleSubmitted');
      expect(i).toBeGreaterThan(-1);
      expect(src.slice(i, i + 700)).toMatch(/isLastPartner && currentRound > 0\) useSessionStore\.getState\(\)\.setLastRatedRound\(currentRound\)/);
    });
    it('#2/#3 — a pulled-out (sent-to-rate) match is completed, not cancelled', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      // the removal terminal status is now a hard 'completed' (was the durationS>30 heuristic)
      expect(src).toMatch(/const terminalStatus: 'completed' = 'completed'/);
      expect(src).not.toMatch(/terminalStatus = \(durationS > 30 \|\| ratingCount > 0\)/);
    });
  });
});
