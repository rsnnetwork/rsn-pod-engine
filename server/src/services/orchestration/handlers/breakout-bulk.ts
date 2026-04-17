// ─── Bulk Manual Breakout Handlers (Task 14) ────────────────────────────────
//
// Builds on Task 13 (handleHostExtendBreakoutRoom) with four new host actions:
//   - host:create_breakout_bulk        — create N manual rooms with shared timer
//   - host:extend_breakout_all         — +X sec to all active manual rooms
//   - host:end_breakout_all            — end all active manual rooms
//   - host:set_breakout_duration_all   — reset shared duration across manual rooms
//
// "Manual" rooms are host-created breakouts whose roomId contains `host-`
// (see handleHostCreateBreakout in host-actions.ts). Algorithm rooms are
// untouched by every bulk handler.
//
// Preserves Change 4.5 + 4.6 behavior:
//   - Uses the same roomTimers/roomSyncIntervals maps so ghost-timer fixes
//     (cb66184) remain in effect — each end-call goes through clearRoomTimers.
//   - Uses status='completed' on explicit end (Change 4.6 semantics — partners
//     who rated anyone still get a rating window via the standard flow).
//   - Host-extend-primitive from Task 13 is reused verbatim for per-room extend.
//
// Forward-compat: this file is the single place to extend bulk actions in the
// future (e.g. bulk mute, bulk return-to-lobby) without touching host-actions.

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { ParticipantStatus } from '@rsn/shared';
import {
  activeSessions, withSessionGuard, userRoom,
} from '../state/session-state';
import {
  roomTimers, roomSyncIntervals, RoomTimerState, verifyHost, clearRoomTimers,
} from './host-actions';
import * as sessionService from '../../session/session.service';
import * as videoService from '../../video/video.service';

// ─── Host dashboard refresh — injected lazily to avoid circular imports ───
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
export function injectBreakoutBulkDeps(deps: {
  emitHostDashboard: (sessionId: string) => Promise<void>;
}): void {
  _emitHostDashboard = deps.emitHostDashboard;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Return matchIds for all active manual breakout rooms in this session. */
async function getActiveManualMatches(sessionId: string): Promise<
  Array<{ id: string; roomId: string; participantAId: string; participantBId: string | null; participantCId: string | null }>
> {
  // Filter on is_manual = TRUE (migration 040) — replaces brittle room_id LIKE pattern.
  const res = await query<{
    id: string;
    room_id: string;
    participant_a_id: string;
    participant_b_id: string | null;
    participant_c_id: string | null;
  }>(
    `SELECT id, room_id, participant_a_id, participant_b_id, participant_c_id
     FROM matches
     WHERE session_id = $1 AND status = 'active' AND is_manual = TRUE`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    roomId: r.room_id,
    participantAId: r.participant_a_id,
    participantBId: r.participant_b_id,
    participantCId: r.participant_c_id,
  }));
}

function participantsOf(m: {
  participantAId: string;
  participantBId: string | null;
  participantCId: string | null;
}): string[] {
  return [m.participantAId, m.participantBId, m.participantCId].filter(
    (x): x is string => !!x,
  );
}

// ─── host:create_breakout_bulk ─────────────────────────────────────────────

export interface BulkCreateRoomSpec {
  participantIds: string[];
}

export async function handleHostCreateBreakoutBulk(
  io: SocketServer,
  socket: Socket,
  data: {
    sessionId: string;
    rooms: BulkCreateRoomSpec[];
    sharedDurationSeconds: number;
    timerVisibility?: 'visible' | 'hidden';
  },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const { sessionId, rooms } = data;
    const sharedDurationSeconds = Math.max(0, Math.floor(data.sharedDurationSeconds || 0));
    const timerVisibility: 'visible' | 'hidden' =
      data.timerVisibility === 'hidden' ? 'hidden' : 'visible';

    if (!Array.isArray(rooms) || rooms.length === 0) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'At least one room is required' });
      return;
    }
    if (rooms.length > 25) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Maximum 25 rooms per bulk create' });
      return;
    }

    // Validate each room
    for (const r of rooms) {
      if (!r.participantIds || r.participantIds.length < 1 || r.participantIds.length > 3) {
        socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Each room needs 1-3 participants' });
        return;
      }
    }

    // Flatten and check for duplicates across rooms
    const allIds = rooms.flatMap((r) => r.participantIds);
    const dedup = new Set(allIds);
    if (dedup.size !== allIds.length) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Participant cannot be in two bulk rooms' });
      return;
    }

    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Event is not active' });
      return;
    }

    const { config: appConfig } = await import('../../../config');
    const { v4: uuid } = await import('uuid');

    const nameRes = await query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE id = ANY($1)`,
      [allIds],
    );
    const nameMap = new Map(nameRes.rows.map((r) => [r.id, r.display_name || 'User']));

    const createdMatchIds: string[] = [];

    for (const roomSpec of rooms) {
      const { participantIds } = roomSpec;

      // Reassign any existing active matches for these participants
      for (const pid of participantIds) {
        try {
          const curr = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
            `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
             WHERE session_id = $1 AND status = 'active'
               AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)`,
            [sessionId, pid],
          );
          if (curr.rows.length > 0) {
            const m = curr.rows[0];
            await query(`UPDATE matches SET status = 'reassigned', ended_at = NOW() WHERE id = $1 AND status = 'active'`, [m.id]);
            clearRoomTimers(m.id);
            const remainingPartners = [m.participant_a_id, m.participant_b_id, m.participant_c_id]
              .filter((id): id is string => !!id && id !== pid && !participantIds.includes(id));
            for (const partnerId of remainingPartners) {
              io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: m.id });
            }
          }
        } catch (err) {
          logger.warn({ err, pid }, 'Non-fatal: failed to clear prior match during bulk create');
        }
      }

      // Create LiveKit room
      const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await videoService.createMatchRoom(sessionId, activeSession.currentRound, roomSlug);
      } catch (err) {
        logger.error({ err, roomSlug }, 'Failed to create LiveKit room in bulk create');
        socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create one of the rooms.' });
        continue;
      }
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);

      // Insert match — is_manual=TRUE so algorithm exclusion ignores this match.
      const matchId = uuid();
      const sorted = [...participantIds].sort();
      try {
        await query(
          `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, timer_visibility, is_manual)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8, TRUE)`,
          [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1] || null, sorted[2] || null, newRoomId, timerVisibility],
        );
      } catch (err: any) {
        logger.error({ err, matchId }, 'Failed to insert match in bulk create');
        // Surface participant-already-matched constraint violation to host.
        if (err?.code === '23505' || /unique|duplicate|already/i.test(err?.message || '')) {
          socket.emit('error', {
            code: 'PARTICIPANT_ALREADY_MATCHED',
            message: 'One or more participants are already in another active match. Wait for it to end.',
          });
        } else {
          socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Failed to create match records.' });
        }
        continue;
      }
      createdMatchIds.push(matchId);

      // Update participant statuses
      for (const pid of participantIds) {
        await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_ROUND).catch(() => {});
      }

      // Emit match:reassigned to each participant
      for (const pid of participantIds) {
        const partners = participantIds
          .filter((id) => id !== pid)
          .map((id) => ({ userId: id, displayName: nameMap.get(id) || 'User' }));

        let token: string | null = null;
        try {
          const vt = await videoService.issueJoinToken(pid, newRoomId, nameMap.get(pid) || 'User');
          token = vt.token;
        } catch { /* client retries */ }

        io.to(userRoom(pid)).emit('match:reassigned', {
          matchId,
          newPartnerId: partners[0]?.userId,
          partnerDisplayName: partners[0]?.displayName,
          partners,
          roomId: newRoomId,
          roundNumber: activeSession.currentRound,
          token,
          livekitUrl: appConfig.livekit.host,
          timerVisibility,
        });
      }

      // Per-room timer — only if shared duration set
      if (sharedDurationSeconds > 0) {
        if (roomTimers.has(matchId)) clearTimeout(roomTimers.get(matchId)!.timeoutHandle);
        const startedAt = new Date();
        const endsAt = new Date(startedAt.getTime() + sharedDurationSeconds * 1000);

        // Emit only if visible — keep the server-side sync loop consistent, but
        // the 5s sync interval also respects visibility at emit time.
        roomSyncIntervals.set(matchId, setInterval(() => {
          const state = roomTimers.get(matchId);
          if (!state) {
            const iv = roomSyncIntervals.get(matchId);
            if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
            return;
          }
          const remaining = Math.max(0, Math.ceil((state.endsAt.getTime() - Date.now()) / 1000));
          if (timerVisibility === 'visible') {
            for (const pid of state.participantIds) {
              io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: remaining });
            }
          }
          if (remaining <= 0) {
            const iv = roomSyncIntervals.get(matchId);
            if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
          }
        }, 5000));

        const fireCallback = async () => {
          roomTimers.delete(matchId);
          const iv = roomSyncIntervals.get(matchId);
          if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
          try {
            const mr = await query<{ status: string }>(
              `SELECT status FROM matches WHERE id = $1`, [matchId],
            );
            if (!mr.rows[0] || mr.rows[0].status !== 'active') return;

            await query(
              `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
              [matchId],
            );

            const localNameRes = await query<{ id: string; display_name: string }>(
              `SELECT id, display_name FROM users WHERE id = ANY($1)`, [participantIds],
            );
            const localNameMap = new Map(localNameRes.rows.map((r) => [r.id, r.display_name || 'Partner']));

            for (const pid of participantIds) {
              const partners = participantIds
                .filter((id) => id !== pid)
                .map((id) => ({ userId: id, displayName: localNameMap.get(id) || 'Partner' }));

              await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_LOBBY).catch(() => {});

              io.to(userRoom(pid)).emit('rating:window_open', {
                matchId,
                partnerId: partners[0]?.userId,
                partnerDisplayName: partners[0]?.displayName,
                partners,
                durationSeconds: 20,
                earlyLeave: true,
              });

              const session = await sessionService.getSessionById(sessionId);
              if (session.lobbyRoomId) {
                try {
                  const socketsInRoom = await io.in(userRoom(pid)).fetchSockets();
                  for (const sk of socketsInRoom) {
                    const uid = (sk.data as any)?.userId;
                    if (uid !== pid) continue;
                    const dName = (sk.data as any)?.displayName || 'User';
                    const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
                    sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: session.lobbyRoomId });
                  }
                } catch { /* skip */ }
              }
            }

            if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
            logger.info({ sessionId, matchId }, 'Bulk breakout room timer expired');
          } catch (err) {
            logger.error({ err, matchId }, 'Error in bulk breakout room timer expiry');
          }
        };

        const timeoutHandle = setTimeout(() => { fireCallback(); }, sharedDurationSeconds * 1000);
        const state: RoomTimerState = {
          timeoutHandle,
          endsAt,
          startedAt,
          participantIds: [...participantIds],
          fireCallback,
        };
        roomTimers.set(matchId, state);

        if (timerVisibility === 'visible') {
          for (const pid of participantIds) {
            io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: sharedDurationSeconds });
          }
        }
      }
    }

    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

    logger.info(
      { sessionId, roomCount: rooms.length, createdMatchIds, sharedDurationSeconds, timerVisibility },
      'Host created bulk breakout rooms',
    );
  });
}

// ─── host:extend_breakout_all ──────────────────────────────────────────────

export async function handleHostExtendBreakoutAll(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; additionalSeconds?: number },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const additionalSeconds = Math.max(1, Math.floor(data.additionalSeconds || 120));
    const { sessionId } = data;

    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session not active.' });
      return;
    }

    const manuals = await getActiveManualMatches(sessionId);
    if (manuals.length === 0) {
      logger.info({ sessionId }, 'Bulk extend: no active manual rooms');
      socket.emit('info', { message: 'No active manual rooms to extend.' });
      return;
    }

    let extendedCount = 0;
    for (const m of manuals) {
      const roomTimer = roomTimers.get(m.id);
      if (!roomTimer) continue; // no per-room timer (unlimited) — skip

      const newEndsAt = new Date(roomTimer.endsAt.getTime() + additionalSeconds * 1000);
      roomTimer.endsAt = newEndsAt;

      clearTimeout(roomTimer.timeoutHandle);
      const msRemaining = Math.max(0, newEndsAt.getTime() - Date.now());
      roomTimer.timeoutHandle = setTimeout(() => { roomTimer.fireCallback(); }, msRemaining);

      const secondsRemaining = Math.ceil(msRemaining / 1000);
      for (const pid of roomTimer.participantIds) {
        io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining });
      }
      extendedCount++;
    }

    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

    logger.info(
      { sessionId, extendedCount, additionalSeconds },
      'Host extended all manual breakout room timers',
    );
  });
}

// ─── host:end_breakout_all ─────────────────────────────────────────────────

export async function handleHostEndBreakoutAll(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const { sessionId } = data;
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session not active.' });
      return;
    }

    const manuals = await getActiveManualMatches(sessionId);
    if (manuals.length === 0) {
      socket.emit('info', { message: 'No active manual rooms to end.' });
      return;
    }

    const { config: appConfig } = await import('../../../config');

    for (const m of manuals) {
      const pids = participantsOf(m);
      // Clear per-room timer
      clearRoomTimers(m.id);

      // Mark match completed (Change 4.6 terminal status for explicit end)
      await query(
        `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
        [m.id],
      ).catch((err) => logger.error({ err, matchId: m.id }, 'Failed to complete match in bulk end'));

      // Close LiveKit room (debug-on-404, preserved from Change 4.5 666dfb0)
      try {
        await videoService.getVideoProvider().closeRoom(m.roomId);
      } catch { /* soft-fail: rooms time out naturally */ }

      // Names for rating window
      const nameRes = await query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id = ANY($1)`, [pids],
      );
      const nm = new Map(nameRes.rows.map((r) => [r.id, r.display_name || 'Partner']));

      for (const pid of pids) {
        const partners = pids.filter((id) => id !== pid)
          .map((id) => ({ userId: id, displayName: nm.get(id) || 'Partner' }));

        await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_LOBBY).catch(() => {});

        io.to(userRoom(pid)).emit('rating:window_open', {
          matchId: m.id,
          partnerId: partners[0]?.userId,
          partnerDisplayName: partners[0]?.displayName,
          partners,
          durationSeconds: 20,
          earlyLeave: true,
        });

        // Return to lobby — issue new LiveKit token for lobby room
        const session = await sessionService.getSessionById(sessionId);
        if (session.lobbyRoomId) {
          try {
            const socketsInRoom = await io.in(userRoom(pid)).fetchSockets();
            for (const sk of socketsInRoom) {
              const uid = (sk.data as any)?.userId;
              if (uid !== pid) continue;
              const dName = (sk.data as any)?.displayName || 'User';
              const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
              sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: session.lobbyRoomId });
            }
          } catch { /* skip */ }
        }

        io.to(userRoom(pid)).emit('match:return_to_lobby', { reason: 'host_ended_room' });
      }
    }

    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

    logger.info(
      { sessionId, endedCount: manuals.length },
      'Host ended all manual breakout rooms',
    );
  });
}

// ─── host:set_breakout_duration_all ────────────────────────────────────────

export async function handleHostSetBreakoutDurationAll(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; durationSeconds: number },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const durationSeconds = Math.max(10, Math.floor(data.durationSeconds || 0));
    const { sessionId } = data;

    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session not active.' });
      return;
    }

    const manuals = await getActiveManualMatches(sessionId);
    if (manuals.length === 0) {
      socket.emit('info', { message: 'No active manual rooms.' });
      return;
    }

    let updatedCount = 0;
    for (const m of manuals) {
      const roomTimer = roomTimers.get(m.id);
      if (!roomTimer) continue; // no pre-existing timer — skip (unlimited rooms stay unlimited)

      const newEndsAt = new Date(roomTimer.startedAt.getTime() + durationSeconds * 1000);
      // If new endsAt is in the past, clamp to now+5s (fire almost immediately
      // rather than instantly — gives clients a chance to render the 0 state).
      const clampedEndsAt = newEndsAt.getTime() < Date.now() + 5000
        ? new Date(Date.now() + 5000)
        : newEndsAt;
      roomTimer.endsAt = clampedEndsAt;

      clearTimeout(roomTimer.timeoutHandle);
      const msRemaining = Math.max(0, clampedEndsAt.getTime() - Date.now());
      roomTimer.timeoutHandle = setTimeout(() => { roomTimer.fireCallback(); }, msRemaining);

      const secondsRemaining = Math.ceil(msRemaining / 1000);
      for (const pid of roomTimer.participantIds) {
        io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining });
      }
      updatedCount++;
    }

    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

    logger.info(
      { sessionId, updatedCount, durationSeconds },
      'Host set duration for all manual breakout rooms',
    );
  });
}
