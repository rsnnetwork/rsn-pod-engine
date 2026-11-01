// ─── An event for a whole circle (T13, 1 Nov 2026; L20, L21) ─────────────────────────────────────────────
//
// A circle event still lives in its pod; sessions.circle_id names the circle whose active members are its
// audience too (event-access.ts, eventAudienceSql). This file holds what the event paths need about the circle:
//   - who may name a circle on an event: its managers (isCircleManager: the creator, an owner or moderator, a
//     platform admin), for a circle that exists and is not archived;
//   - the bells: one event_invite per active member but the person who scheduled it, in one INSERT … SELECT,
//     and never an email;
//   - the circle as the event page names it.

import { ErrorCodes, type SessionCircle } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { fanoutCircleEvent } from '../../realtime/fanout';
import { activeMemberSql } from '../users/active-member';
import { isCircleManager } from './circle-managers';

/** The refusal a person who does not run the circle reads. */
export const circleEventRefusal = (circleName: string) => `Only the people who run ${circleName} can schedule an event for it.`;

/**
 * The circle a new or edited event is to be for: it exists and is not archived (404 otherwise), and the person runs
 * it (403 in a sentence otherwise). Returns the circle's id and name.
 */
export async function assertMayScheduleForCircle(circleId: string, userId: string, role: string | undefined): Promise<SessionCircle> {
  const found = await query<SessionCircle>(
    `SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL`,
    [circleId],
  );
  const circle = found.rows[0];
  if (!circle) throw new NotFoundError('Circle', circleId);
  if (!(await isCircleManager(circleId, userId, role))) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, circleEventRefusal(circle.name));
  }
  return circle;
}

/**
 * Whether the person may take the circle off an event: one of its managers (archived or not: an archived circle's
 * event may still be handed back to its pod). A circle that no longer exists holds nobody, so anyone may.
 */
export async function assertMayClearCircle(circleId: string, userId: string, role: string | undefined): Promise<void> {
  const found = await query<{ name: string }>(`SELECT name FROM circles WHERE id = $1`, [circleId]);
  const circle = found.rows[0];
  if (!circle) return;
  if (!(await isCircleManager(circleId, userId, role))) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, circleEventRefusal(circle.name));
  }
}

/** The circle an event is for, as its page names it: null when it has none or the circle is archived. */
export async function readEventCircle(circleId: string | null | undefined): Promise<SessionCircle | null> {
  if (!circleId) return null;
  const found = await query<SessionCircle>(
    `SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL`,
    [circleId],
  );
  return found.rows[0] ?? null;
}

/**
 * Rings each active member of the circle but `actorId` once about the event: "New event in {circle}", linking the
 * event page. One statement however big the circle is. No email (L20). A bell that fails never undoes the event.
 * Returns the people rung.
 */
export async function ringCircleEvent(circle: SessionCircle, sessionId: string, actorId: string): Promise<string[]> {
  const title = `New event in ${circle.name}`;
  const link = `/sessions/${sessionId}`;
  try {
    const inserted = await query<{ id: string; user_id: string; body: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT cm.user_id, 'event_invite', $3, s.title, $4
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         JOIN sessions s ON s.id = $2
        WHERE cm.circle_id = $1
          AND cm.user_id <> $5
          AND ${activeMemberSql('u')}
       RETURNING id, user_id, body, created_at`,
      [circle.id, sessionId, title, link, actorId],
    );
    const io = getRealtimeIo();
    if (io) {
      for (const row of inserted.rows) {
        io.to(`user:${row.user_id}`).emit('notification:new', {
          id: row.id, type: 'event_invite', title, body: row.body, link, isRead: false, createdAt: row.created_at,
        });
        emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]).catch(() => {});
      }
    }
    return inserted.rows.map((r) => r.user_id);
  } catch (err) {
    logger.warn({ err, circleId: circle.id, sessionId }, 'Circle event bells failed (non-fatal)');
    return [];
  }
}

/**
 * An event now names `circle` (created for it, or edited to it): its members are rung, then every one of them,
 * the circle's page and the event's page hear it. `previousCircleId`: a circle the event was for before, whose
 * members' lists drop it. Never throws.
 */
export async function announceCircleEvent(params: {
  sessionId: string;
  actorId: string;
  circle: SessionCircle | null;
  previousCircleId?: string | null;
}): Promise<void> {
  const { sessionId, actorId, circle, previousCircleId } = params;
  if (circle) await ringCircleEvent(circle, sessionId, actorId);
  if (circle) fanoutCircleEvent(circle.id, sessionId, actorId).catch(() => {});
  if (previousCircleId && previousCircleId !== circle?.id) {
    fanoutCircleEvent(previousCircleId, sessionId, actorId).catch(() => {});
  }
}
