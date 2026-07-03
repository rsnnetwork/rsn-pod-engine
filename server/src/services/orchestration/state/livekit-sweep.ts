// ─── Phase-4 LiveKit Reconciliation Sweep (Ship B) ──────────────────────────
// Design §9: "Periodic sweep (~15s): for each active room, listParticipants
// vs canonical roster; heal diffs (catches missed webhooks)."
//
// Scope decision (deliberate): the sweep does POSITIVE heals only —
// a LiveKit roster member whose canonical connState isn't 'connected' gets
// healed to connected (a missed participant_joined webhook). Missed-JOIN is
// the harmful direction for the canonical-gated read paths: a present-but-
// excluded user is the recurring "present people weren't matched" bug class.
// The reverse (missed participant_left) is already covered within 90s by the
// stale-heartbeat sweep, whose setPresence(null) now mirrors 'disconnected'
// into canonical. Absence-marking from LiveKit rosters here would FLAP for
// camera-denied main-room users who are socket-present but never join the
// lobby LiveKit room. Room-mismatch is logged for observability only —
// eviction stays webhook/command-driven.

import logger from '../../../config/logger';
import { query } from '../../../db';
import { activeSessions } from './session-state';
import { readCanonical, updateCanonicalParticipant, clearCanonicalLocationToMain } from './canonical-state';

/**
 * Shared connState heal — the single write used by BOTH the LiveKit webhook
 * receiver (push) and the periodic sweep (pull), so the two reconciliation
 * paths can never diverge in behaviour.
 */
export async function healParticipantConnState(
  sessionId: string,
  userId: string,
  connState: 'connected' | 'disconnected',
): Promise<void> {
  await updateCanonicalParticipant(
    sessionId, userId,
    connState === 'connected'
      ? { connState, lastSeenAt: Date.now() }
      : { connState },
  );
}

/**
 * Reconcile one room's live LiveKit roster against the canonical doc.
 * Returns the number of participants healed.
 */
export async function reconcileRoomRoster(
  sessionId: string,
  roomId: string,
  roster: { userId: string }[],
  lobbyRoomId: string | null,
): Promise<number> {
  const doc = await readCanonical(sessionId);
  if (!doc) return 0;
  let healed = 0;
  for (const p of roster) {
    if (!p.userId) continue;
    const cp = doc.participants[p.userId];
    if (!cp) continue;                    // unknown identity — not ours to heal
    if (cp.connState === 'removed') continue; // never resurrect / evict a kicked user
    if (cp.connState !== 'connected') {
      await healParticipantConnState(sessionId, p.userId, 'connected');
      healed++;
      logger.info({ sessionId, roomId, userId: p.userId, was: cp.connState },
        'LiveKit sweep: healed connState (missed join webhook)');
    }
    // One-active-room enforcement (3 Jul, Stefan "THE TEST"): a participant
    // present in a room that is NOT their canonical room is a stale duplicate
    // membership — their tile shows in two rooms at once. Remove them from
    // THIS room when it is safe to do so:
    //   • THIS room is a breakout that isn't theirs → always safe (a dead/old
    //     breakout; healStrandedBreakoutLocations already ran, so canonical is
    //     fresh).
    //   • THIS room is the LOBBY and they canonically belong in a breakout
    //     DURING AN ACTIVE ROUND → safe (Ali's dual-tile case: mid-round he had
    //     no business in the lobby). But NEVER during ROUND_TRANSITION / rating
    //     / lobby phases: returners legitimately land in the lobby then and a
    //     late heartbeat may still read breakout — evicting there is the 13-Jun
    //     / 14-Jun "no video after round" bug.
    const canonicalRoom = cp.location.type === 'breakout' ? cp.location.roomId : lobbyRoomId;
    const isStaleHere = !!canonicalRoom && roomId !== canonicalRoom;
    const roomIsBreakout = !!lobbyRoomId && roomId !== lobbyRoomId;
    const safeLobbyRemoval = !!lobbyRoomId && roomId === lobbyRoomId
      && cp.location.type === 'breakout'
      && doc.status === 'round_active';
    if (isStaleHere && (roomIsBreakout || safeLobbyRemoval)) {
      try {
        const videoSvc = await import('../../video/video.service');
        await videoSvc.evictFromRoom(p.userId, roomId);
        logger.info({ sessionId, roomId, userId: p.userId, canonicalRoom },
          'LiveKit sweep: removed stale breakout membership (one-active-room)');
      } catch (err) {
        logger.warn({ err, sessionId, roomId, userId: p.userId },
          'LiveKit sweep: stale-membership removal failed (non-fatal)');
      }
    }
  }
  return healed;
}

/**
 * 3 Jul (Stefan "THE TEST") — return-to-main rail #2. After a round ends,
 * `endRound` batch-clears canonical breakout locations and the transition
 * pushes a snapshot; but a participant who was DISCONNECTED at the clear (a
 * flapping mobile tab) can be left with a canonical 'breakout' location
 * pointing at an already-ended match — and if their client never sends a clean
 * resync they sit STUCK, seeing the old breakout / a blank main. The resync
 * heal (state-snapshot.ts) only fires on a client-initiated resync. This runs
 * on the periodic sweep so any participant stranded in a non-active breakout is
 * converged to main within one tick with NO client action required.
 * Returns the userIds healed.
 */
export async function healStrandedBreakoutLocations(sessionId: string): Promise<string[]> {
  const doc = await readCanonical(sessionId);
  if (!doc) return [];
  const healed: string[] = [];
  for (const [userId, p] of Object.entries(doc.participants)) {
    if (p.location.type !== 'breakout') continue;
    const matchId = p.location.matchId;
    try {
      const m = await query<{ status: string }>(
        `SELECT status FROM matches WHERE id = $1`, [matchId],
      );
      // Not active (completed / cancelled / vanished) → the breakout is dead;
      // return them to main so the lobby-token rail lands them with everyone.
      if (m.rows[0]?.status !== 'active') {
        await clearCanonicalLocationToMain(sessionId, userId);
        healed.push(userId);
        logger.info({ sessionId, userId, matchId },
          'sweep heal: stranded breakout → main (match not active)');
      }
    } catch { /* best-effort per participant — one bad lookup never stalls the rest */ }
  }
  return healed;
}

const SWEEP_INTERVAL_MS = 15_000;
const LIST_TIMEOUT_MS = 4_000;
let _sweepHandle: NodeJS.Timeout | null = null;

/**
 * Single global 15s interval (mirrors startGlobalReconciler). Per active
 * session: enumerate the lobby room + every active match's breakout room
 * (ALL active matches — algorithm AND manual), list each room's LiveKit
 * roster, reconcile. Every lookup is best-effort with its own catch; one
 * bad room/session never stalls the sweep.
 */
export function startLiveKitSweep(): void {
  if (_sweepHandle) return;
  _sweepHandle = setInterval(async () => {
    for (const sessionId of activeSessions.keys()) {
      try {
        const rooms = new Set<string>();
        // Smoke-caught hotfix: getSessionById THROWS for an in-memory session
        // whose DB row is gone (ended events recovered from a stale Redis
        // blob) — pre-fix this warn-spammed every 15s per stale session until
        // the 4h TTL reaper. No DB row = event over = nothing to sweep.
        const session = await (await import('../../session/session.service'))
          .getSessionById(sessionId).catch(() => null);
        if (!session) continue;
        // Return-to-main rail #2 — heal anyone stranded in a dead breakout
        // before we reconcile rosters (best-effort; never stalls the sweep).
        await healStrandedBreakoutLocations(sessionId).catch(() => {});
        if (session.lobbyRoomId) rooms.add(session.lobbyRoomId);
        const active = await query<{ room_id: string }>(
          `SELECT DISTINCT room_id FROM matches
            WHERE session_id = $1 AND status = 'active' AND room_id IS NOT NULL`,
          [sessionId],
        );
        for (const r of active.rows) if (r.room_id) rooms.add(r.room_id);

        const videoSvc = await import('../../video/video.service');
        for (const roomId of rooms) {
          try {
            const roster = await Promise.race([
              videoSvc.listParticipants(roomId),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('listParticipants timeout')), LIST_TIMEOUT_MS)),
            ]);
            await reconcileRoomRoster(sessionId, roomId, roster, session.lobbyRoomId ?? null);
          } catch (err) {
            logger.warn({ err, sessionId, roomId }, 'LiveKit sweep: room reconcile failed (non-fatal)');
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId }, 'LiveKit sweep: session tick failed (non-fatal)');
      }
    }
  }, SWEEP_INTERVAL_MS);
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'LiveKit reconciliation sweep started (Phase 4)');
}

export function stopLiveKitSweep(): void {
  if (_sweepHandle) {
    clearInterval(_sweepHandle);
    _sweepHandle = null;
    logger.info('LiveKit reconciliation sweep stopped');
  }
}
