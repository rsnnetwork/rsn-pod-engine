// ─── An overdue event closes itself (10 Nov 2026, F7, spec 12/14) ────────────────────────────────────────────────
//
// An event nobody ended stayed live (or "Upcoming", if nobody ever went live) for ever: on every page that lists it,
// in the host's dashboard, in the members' "live now". Once its start, its length and a grace period have all passed,
// it is over whoever forgot to end it:
//   - a live one is completed through the orchestrator's own completion (completeSession, under the session guard),
//     as End Event completes it: its rooms and matches close, everyone is swept out, every page moves to Ended. It
//     sends no recap email: an overdue close is not a natural end (controller ruling, 10 Nov 2026);
//   - one that never started is marked Ended, with the completed fan-out so every page moves it, and no recap email
//     (nobody met anybody).
// In-person events are not this job's: they have their own ender (in-person-ending.ts). An event with no date has no
// end, and a completed or cancelled one is already over.
//
// Three modes (config.overdueEventClose): off, report (log the events it would close, write nothing: the default, so
// production shows its list before it is trusted; an unchanged list is logged again at most every 30 minutes), end.

import { SessionStatus } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { config } from '../../config';
import { eventDurationOf } from './event-duration';
import { fanoutSessionCompleted } from '../../realtime/fanout';
import { getRealtimeIo } from '../../realtime/emit';
import { withSessionGuard } from '../orchestration/state/session-state';
import { completeSession } from '../orchestration/handlers/round-lifecycle';

/** How often the server looks for overdue events. */
export const OVERDUE_EVENT_INTERVAL_MS = 60 * 1000;
/** The most events one tick closes; the rest wait for the next. */
export const OVERDUE_EVENTS_PER_TICK = 50;
/**
 * Rows read per tick, oldest first. The SQL can only rule out events whose start plus the grace has not passed (an
 * event's length is worked out from its format and config here, not in SQL), so it reads more than it closes.
 */
const CANDIDATES_PER_TICK = 500;

/** The statuses of an event that is running: the host went live and nobody has ended it. */
const LIVE_STATUSES: readonly string[] = [
  SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING,
  SessionStatus.ROUND_TRANSITION, SessionStatus.CLOSING_LOBBY,
];

export type OverdueEventMode = 'off' | 'report' | 'end';

/** Report mode repeats an unchanged list at most this often (it runs every minute, on every instance). */
export const OVERDUE_REPORT_REPEAT_MS = 30 * 60 * 1000;
/** The last list report mode logged, and when: the same list is logged again only after OVERDUE_REPORT_REPEAT_MS. */
let lastReport: { key: string; at: number } | null = null;

/** Whether report mode should log this list now: it changed, or the last log of it is 30 minutes old. */
function reportIsDue(wouldClose: string[], now: Date): boolean {
  const key = [...wouldClose].sort().join(',');
  if (lastReport && lastReport.key === key && now.getTime() - lastReport.at < OVERDUE_REPORT_REPEAT_MS) return false;
  lastReport = { key, at: now.getTime() };
  return true;
}

interface CandidateRow {
  id: string;
  status: string;
  scheduled_at: Date;
  event_format: string | null;
  config: unknown;
}

/** The candidates whose start, length and grace have all passed by `now`, oldest end first, at most a tick's worth. */
function overdueOf(rows: CandidateRow[], now: Date, graceMinutes: number): CandidateRow[] {
  return rows
    .map(row => ({ row, closesAt: new Date(row.scheduled_at).getTime() + (eventDurationOf(row) + graceMinutes) * 60_000 }))
    .filter(({ closesAt }) => Number.isFinite(closesAt) && closesAt <= now.getTime())
    .sort((a, b) => a.closesAt - b.closesAt)
    .slice(0, OVERDUE_EVENTS_PER_TICK)
    .map(({ row }) => row);
}

/**
 * Completes a live event through the orchestrator's completion, under the session guard, as End Event does, but with
 * no recap email: an overdue close is not a natural end (controller ruling, 10 Nov 2026). Resolves whether this call
 * ended it (false when someone else already had).
 */
async function completeLiveEvent(sessionId: string): Promise<boolean> {
  const io = getRealtimeIo();
  if (!io) throw new Error('Realtime server not ready');
  return withSessionGuard(sessionId, () => completeSession(io, sessionId, { reason: 'overdue', sendRecap: false }));
}

/**
 * Marks an event that never started as Ended and tells every page that shows it. Only while it is still scheduled:
 * one that went live (or was cancelled) meanwhile is left alone. Returns whether it was this call that ended it.
 */
async function endNeverStartedEvent(sessionId: string): Promise<boolean> {
  const claimed = await query<{ id: string }>(
    `UPDATE sessions SET status = 'completed', ended_at = NOW(), lobby_room_id = NULL
      WHERE id = $1 AND status = 'scheduled'
      RETURNING id`,
    [sessionId],
  );
  if (claimed.rows.length === 0) return false;
  await fanoutSessionCompleted(sessionId);
  return true;
}

/**
 * Finds the events whose start plus length plus `config.overdueEventGraceMinutes` has passed and that are still live
 * or never started (in-person, dateless, completed and cancelled events excluded), at most 50. In report mode it logs
 * and returns them as `wouldClose` and changes nothing; in end mode it also closes each one on its own, so one failure
 * leaves the rest to close and is tried again next tick.
 */
export async function closeOverdueEvents(
  mode: OverdueEventMode,
  now: Date = new Date(),
): Promise<{ wouldClose: string[]; closed: string[] }> {
  if (mode === 'off') return { wouldClose: [], closed: [] };
  const graceMinutes = Math.max(0, Math.ceil(config.overdueEventGraceMinutes));

  const candidates = await query<CandidateRow>(
    `SELECT id, status, scheduled_at, event_format, config
       FROM sessions
      WHERE status IN ('scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby')
        AND scheduled_at IS NOT NULL
        AND event_format IS DISTINCT FROM 'physical_event'
        AND scheduled_at <= $1::timestamptz - make_interval(mins => $2::int)
      ORDER BY scheduled_at
      LIMIT ${CANDIDATES_PER_TICK}`,
    [now, graceMinutes],
  );
  const due = overdueOf(candidates.rows, now, graceMinutes);
  const wouldClose = due.map(row => row.id);
  if (due.length === 0) return { wouldClose, closed: [] };

  if (mode === 'report') {
    if (!reportIsDue(wouldClose, now)) return { wouldClose, closed: [] };
    logger.info({
      mode, graceMinutes, count: due.length, wouldClose,
      events: due.map(row => ({ id: row.id, status: row.status, scheduledAt: row.scheduled_at })),
    }, 'Overdue events: WOULD close these (report mode, nothing written)');
    return { wouldClose, closed: [] };
  }

  const closed: string[] = [];
  for (const row of due) {
    try {
      if (LIVE_STATUSES.includes(row.status)) {
        if (await completeLiveEvent(row.id)) closed.push(row.id);
      } else if (await endNeverStartedEvent(row.id)) {
        closed.push(row.id);
      }
    } catch (err) {
      logger.warn({ err, sessionId: row.id }, 'Overdue events: could not close that one (will retry next tick)');
    }
  }
  if (closed.length > 0) logger.info({ mode, graceMinutes, count: closed.length, closed }, 'Overdue events closed');
  return { wouldClose, closed };
}
