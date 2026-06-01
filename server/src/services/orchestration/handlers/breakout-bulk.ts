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
import { query, transaction } from '../../../db';
import { ParticipantStatus } from '@rsn/shared';
import {
  activeSessions, withSessionGuard, userRoom, emitRatingWindowOnce,
} from '../state/session-state';
import {
  roomTimers, roomSyncIntervals, RoomTimerState, verifyHost, clearRoomTimers,
  ensureManualDashboardInterval,
} from './host-actions';
import * as sessionService from '../../session/session.service';
import * as videoService from '../../video/video.service';
import { validateMatchAssignment } from '../../matching/match-validator.service';

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

    // Bug 7 (April 19 Dr Arch) — REJECT bulk-create if any selected participant
    // is currently in another active match (algorithm OR manual). Previously
    // we silently REASSIGNED them out of their existing match into the new
    // manual room; the host had no idea they were yanking people out of
    // a live conversation. New rule: host must wait for participants to
    // leave their current room (or end it explicitly) before pulling them
    // into a new manual breakout.
    //
    // Forward-compat: same `m.status = 'active'` predicate that the trigger
    // and partial unique index use (migrations 041 + 042) — single source of
    // truth across DB constraints, server validation, and dashboard.
    const inUseRes = await query<{ user_id: string }>(
      `SELECT DISTINCT u.id AS user_id
         FROM users u
         JOIN matches m ON m.session_id = $1 AND m.status = 'active'
              AND (m.participant_a_id = u.id OR m.participant_b_id = u.id OR m.participant_c_id = u.id)
        WHERE u.id = ANY($2)`,
      [sessionId, allIds],
    );
    if (inUseRes.rows.length > 0) {
      const blockedNames = inUseRes.rows
        .map((r) => nameMap.get(r.user_id) || 'A participant')
        .sort();
      socket.emit('error', {
        code: 'PARTICIPANT_IN_ACTIVE_ROOM',
        message:
          blockedNames.length === 1
            ? `${blockedNames[0]} is already in an active room. End that room first or wait for them to leave.`
            : `${blockedNames.join(', ')} are already in active rooms. End those rooms first or wait for them to leave.`,
        userIds: inUseRes.rows.map((r) => r.user_id),
      });
      // Refresh dashboard so the host's modal closes / updates state.
      if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
      return;
    }

    const createdMatchIds: string[] = [];

    // Phase 6 (5 May spec) — atomic per-room bulk-create.
    // Same pattern as Phase 4A on handleHostCreateBreakout:
    //   1. LiveKit room first (fail-fast — no DB writes if it can't be created)
    //   2. Reassign + insert wrapped in a single transaction
    //   3. Notifications + setRoomAssignment AFTER the transaction commits
    // If any room in the bulk fails, that room is skipped (continue) but
    // earlier rooms' transactions stay committed and later rooms still
    // attempt — preserving the partial-success behaviour the host expects
    // ("4 of 5 rooms were created successfully").

    for (const roomSpec of rooms) {
      const { participantIds } = roomSpec;

      // Step 1 — LiveKit room first
      const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await videoService.createMatchRoom(sessionId, activeSession.currentRound, roomSlug);
      } catch (err) {
        logger.error({ err, roomSlug }, 'Failed to create LiveKit room in bulk create');
        socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create one of the rooms.' });
        continue;
      }
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);

      // Pre-transaction validation (structural only — conflict check skipped
      // since the in-tx reassign clears any active-match conflicts).
      const matchId = uuid();
      const sorted = [...participantIds].sort();
      const validation = await validateMatchAssignment({
        sessionId,
        roundNumber: activeSession.currentRound,
        participantAId: sorted[0],
        participantBId: sorted[1] || null,
        participantCId: sorted[2] || null,
        skipConflictCheck: true,
      });
      if (!validation.valid) {
        logger.error({ sessionId, matchId, errors: validation.errors }, 'Bulk-create validator caught invalid room');
        socket.emit('error', {
          code: 'INVALID_MATCH_ASSIGNMENT',
          message: validation.errors.join('; '),
        });
        continue;
      }

      // Step 2 — atomic transaction: reassign existing + insert new
      type ReassignedMatch = { matchId: string; remainingPartners: string[] };
      const reassignedForNotification: ReassignedMatch[] = [];
      try {
        await transaction(async (client) => {
          for (const pid of participantIds) {
            const curr = await client.query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
              `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
               WHERE session_id = $1 AND status = 'active'
                 AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)`,
              [sessionId, pid],
            );
            if (curr.rows.length === 0) continue;
            const m = curr.rows[0];
            await client.query(
              `UPDATE matches SET status = 'reassigned', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
              [m.id],
            );
            const remainingPartners = [m.participant_a_id, m.participant_b_id, m.participant_c_id]
              .filter((id): id is string => !!id && id !== pid && !participantIds.includes(id));
            reassignedForNotification.push({ matchId: m.id, remainingPartners });
          }

          await client.query(
            `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, timer_visibility, is_manual)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8, TRUE)`,
            [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1] || null, sorted[2] || null, newRoomId, timerVisibility],
          );
        });
      } catch (err: any) {
        logger.error({ err, matchId }, 'Phase 6 — atomic bulk-room transaction rolled back');
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

      // Post-transaction: clear timers for reassigned matches + emit
      // partner-disconnected. Runs only for rooms that committed.
      for (const reassigned of reassignedForNotification) {
        clearRoomTimers(reassigned.matchId);
        for (const partnerId of reassigned.remainingPartners) {
          io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: reassigned.matchId });
        }
      }

      createdMatchIds.push(matchId);

      // Phase 0 (1 May spec) — server-canonical room assignment for manual
      // host-created breakouts. Same architectural rule as auto-rounds:
      // populate roomParticipants now so room-scope chat works regardless
      // of which client's LiveKit connects first.
      const { setRoomAssignment } = await import('./participant-flow');
      setRoomAssignment(sessionId, matchId, newRoomId, participantIds);

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
            // Bug 15 (April 19) — include endsAt so the client's Bug 8.5
            // recompute path drives the manual room timer too. Without
            // endsAt the participant fell back to a one-shot setTimer
            // and the digit never ticked down (manual room timer not
            // showing in the breakout window — reported during live test).
            const endsAtIso = state.endsAt.toISOString();
            for (const pid of state.participantIds) {
              io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: remaining, endsAt: endsAtIso });
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

              await emitRatingWindowOnce(io, pid, matchId, {
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
          // Bug 15 — initial timer:sync must include endsAt so the client's
          // Bug 8.5 recompute path takes over (otherwise the digit stays
          // frozen at sharedDurationSeconds and never ticks).
          const initEndsAtIso = endsAt.toISOString();
          for (const pid of participantIds) {
            io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: sharedDurationSeconds, endsAt: initEndsAtIso });
          }
        }
      }
    }

    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
    // Defensive: ensure LOBBY_OPEN dashboard polling is running while any
    // active manual match exists. Self-stops once they all drain.
    ensureManualDashboardInterval(io, sessionId);

    // Phase 8 (1 May spec) — host action receipt for bulk room create.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      const hostUid = activeSession.hostUserId;
      if (hostUid && createdMatchIds.length > 0) {
        emitHostActionConfirmed(io, sessionId, hostUid, {
          action: 'create_breakout_bulk',
          summary: `Created ${createdMatchIds.length} breakout room${createdMatchIds.length === 1 ? '' : 's'}`,
        });
      }
    }

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

        await emitRatingWindowOnce(io, pid, m.id, {
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

        // Bug 14 (April 19) — DO NOT emit match:return_to_lobby here. The
        // client's handler sets phase='lobby' which dismisses the rating
        // prompt that just opened (race: rating:window_open arrives, then
        // match:return_to_lobby arrives ~µs later, phase flips back to
        // lobby, rating UI vanishes). Participants need to RATE first;
        // submitting the rating naturally returns them to lobby via the
        // existing rating-completion flow.
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
