// ─── WS2 (27 May remaining work) — "nobody waits alone" room-end helper ────
//
// A matching breakout needs ≥2 people. When a room drops below 2 — partner
// left (Back to Main), was pulled back by the host, was kicked, or didn't
// return within the 15s disconnect/leave-event grace — the room ENDS for
// whoever remains: survivor rates (reason 'partner_no_return') and returns
// to the main room. There is NO re-pairing (the old isolated-participants
// auto-reassign paths were removed in the same change).
//
// One shared helper so every end-cause produces the identical survivor
// experience. Callers own the match demotion, canonical-location clears,
// room timers, host dashboard, and maybeAutoEndEmptyRound — this module owns
// only the survivor-facing flow (status, rating window, lobby fallback).
//
// Deliberately import-light (db, shared, session-state, session.service,
// realtime) so both participant-flow.ts and host-actions.ts can use it
// without a handler-to-handler import cycle.

import { Server as SocketServer } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { ParticipantStatus, resolveDisplayName, placeholderName } from '@rsn/shared';
import { emitRatingWindowOnce, userRoom } from '../state/session-state';
import * as sessionService from '../../session/session.service';
import { emitEntities } from '../../../realtime/emit';
import { E } from '../../../realtime/entities';

/**
 * End an early-terminated breakout for its survivor(s): IN_LOBBY status,
 * rating window for the departed partner(s) (reason 'partner_no_return'),
 * and a match:return_to_lobby fallback when the window is dedup-skipped so
 * an already-rated survivor is never stranded in a dead room.
 *
 * `ratable: false` (match ended 'cancelled' — under 30s, no ratings: not a
 * real conversation) skips the rating window entirely: prompting someone to
 * rate a 15-second aborted room is noise, and the ratings service only
 * accepts cancelled-match ratings for a 30s grace anyway. Survivors go
 * straight back to the main room.
 *
 * Every step fails open — a DB hiccup on one survivor must not block the
 * others or leave the room half-ended.
 */
export async function endRoomEarlyForSurvivors(
  io: SocketServer,
  sessionId: string,
  matchId: string,
  departedUserIds: string[],
  survivorIds: string[],
  ratable: boolean = true,
): Promise<void> {
  if (survivorIds.length === 0) return;

  if (!ratable) {
    for (const survivorId of survivorIds) {
      try {
        await sessionService.updateParticipantStatus(sessionId, survivorId, ParticipantStatus.IN_LOBBY).catch(() => {});
        io.to(userRoom(survivorId)).emit('match:return_to_lobby', { reason: 'partner_left' });
        emitEntities(
          io, [survivorId],
          [E.session(sessionId), E.sessionParticipants(sessionId), E.match(matchId)],
        ).catch(() => {});
      } catch (err) {
        logger.error({ err, sessionId, matchId, survivorId }, 'endRoomEarlyForSurvivors: non-ratable survivor flow failed');
      }
    }
    logger.info(
      { sessionId, matchId, survivors: survivorIds.length },
      'Room ended early (cancelled, not ratable) — survivor(s) returned to main room',
    );
    return;
  }

  // WS2 — merge the caller's departed id(s) with the match row's
  // departed_user_ids (appended by demoteParticipantFromMatch): a 3→2→1
  // double-leave means the lone survivor must rate BOTH departed members,
  // not just the last one to go. Fail-open: on a lookup error the caller's
  // list still drives the form.
  let allDepartedIds = [...departedUserIds];
  try {
    const depRes = await query<{ departed_user_ids: string[] | null }>(
      `SELECT departed_user_ids FROM matches WHERE id = $1`,
      [matchId],
    );
    for (const id of depRes.rows[0]?.departed_user_ids ?? []) {
      if (!allDepartedIds.includes(id) && !survivorIds.includes(id)) allDepartedIds.push(id);
    }
  } catch (err) {
    logger.warn({ err, sessionId, matchId }, 'endRoomEarlyForSurvivors: departed lookup failed — using caller list');
  }

  // One name lookup for all departed partners (the rating form labels).
  let departedWithNames = allDepartedIds.map(id => ({ userId: id, displayName: placeholderName(id) }));
  try {
    const nameRes = await query<{ id: string; display_name: string | null; email: string | null }>(
      `SELECT id, display_name, email FROM users WHERE id = ANY($1)`,
      [allDepartedIds],
    );
    const nameMap = new Map(nameRes.rows.map(r => [r.id, resolveDisplayName(r.id, r.display_name, r.email)]));
    departedWithNames = allDepartedIds.map(id => ({
      userId: id,
      displayName: nameMap.get(id) || placeholderName(id),
    }));
  } catch (err) {
    logger.warn({ err, sessionId, matchId }, 'endRoomEarlyForSurvivors: name lookup failed — using placeholders');
  }

  for (const survivorId of survivorIds) {
    try {
      await sessionService.updateParticipantStatus(sessionId, survivorId, ParticipantStatus.IN_LOBBY).catch(() => {});

      const emitted = await emitRatingWindowOnce(io, survivorId, matchId, {
        matchId,
        partnerId: departedWithNames[0]?.userId,
        partnerDisplayName: departedWithNames[0]?.displayName,
        partners: departedWithNames,
        durationSeconds: 20,
        earlyLeave: true,
        reason: 'partner_no_return',
      });
      if (!emitted) {
        // Already rated (or host guard) — still pull them out of the dead room.
        io.to(userRoom(survivorId)).emit('match:return_to_lobby', { reason: 'partner_left' });
      }

      emitEntities(
        io, [survivorId],
        [E.session(sessionId), E.sessionParticipants(sessionId), E.match(matchId)],
      ).catch(() => {});
    } catch (err) {
      logger.error({ err, sessionId, matchId, survivorId }, 'endRoomEarlyForSurvivors: survivor flow failed');
    }
  }

  logger.info(
    { sessionId, matchId, survivors: survivorIds.length, departed: departedUserIds.length },
    'Room ended early — survivor(s) sent to rating → main room (no re-pairing)',
  );
}
