// ─── Who can join a circle: asks, answers, removal, and the pods a manager can attach (30 Oct review, T14) ───────
//
// "Who can join a Circle. The owner should choose if a Circle is open or closed (same as Parts)." A closed circle
// (circles.join_policy, migration 128) takes people through an ask its managers answer. Asks live in
// circle_join_requests, never in circle_members, so "member" keeps one meaning everywhere it is read. Every answer
// is taken under a row lock on the ask, so two managers pressing at once make one decision: the second is told the
// ask was already answered. The bells reuse the allowed types join_request and approval (only migration 118 touches
// the allowlist). Managers are the circle's creator, its owners and moderators, and platform admins (L21,
// circle-managers.ts); a platform admin outside the circle is told through the page they act from, not by bell.

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError, ValidationError } from '../../middleware/errors';
import {
  CircleAttachablePodPage, CircleJoinRequest, CircleRequestResult, ErrorCodes,
} from '@rsn/shared';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { activeMemberSql } from '../users/active-member';
import { escapeLike } from '../user/user-search.service';
import { admitToCircle, isCircleMember, joinCircle } from './circle.service';
import { assertCircleManager, isCircleManager, isPlatformAdmin } from './circle-managers';

/** What a manager is told when the ask they answer was answered already, withdrawn, or never made. */
export const REQUEST_ALREADY_ANSWERED = 'This request has already been answered.';

/** Asks shown to a manager at once; a circle with more waiting shows them as they are answered. */
const REQUESTS_SHOWN = 200;

/** The attach picker's page: 50 pods unless fewer are asked for, never more than 100. */
export const ATTACHABLE_PAGE = 50;
export const ATTACHABLE_PAGE_MAX = 100;

/** Who is acting, as the route knows them. */
export interface CircleActor {
  userId: string;
  role?: string;
}

interface CircleRow { id: string; name: string; join_policy: string; created_by: string }

async function liveCircle(circleId: string): Promise<CircleRow> {
  const r = await query<CircleRow>(
    `SELECT id, name, join_policy, created_by FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (!r.rows[0]) throw new NotFoundError('Circle', circleId);
  return r.rows[0];
}

async function displayNameOf(userId: string): Promise<string> {
  const r = await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.display_name?.trim() || 'Someone';
}

/** The pushes for bell rows just written: the row itself, and each person's own notifications tag. Never throws. */
async function pushBells(rows: Array<{ id: string; user_id: string; created_at: Date }>, bell: { type: string; title: string; body: string; link: string }): Promise<void> {
  const io = getRealtimeIo();
  if (!io || rows.length === 0) return;
  try {
    for (const row of rows) {
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type: bell.type, title: bell.title, body: bell.body, link: bell.link, isRead: false, createdAt: row.created_at,
      });
    }
    await Promise.all(rows.map((row) => emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)])));
  } catch (err) {
    logger.warn({ err, type: bell.type, link: bell.link }, 'circle bell push failed (non-fatal)');
  }
}

/**
 * The people an ask rings: the circle's creator, owners and moderators whose accounts are active; when none of them
 * is (the creator's account was closed and nobody else runs it), the platform admins, who still manage every circle.
 */
async function managersToRing(circle: CircleRow, askerId: string): Promise<string[]> {
  const own = await query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE ${activeMemberSql('u')} AND u.id <> $3
        AND (u.id = $2 OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = $1 AND m.user_id = u.id
                                     AND m.role IN ('owner', 'moderator')))`,
    [circle.id, circle.created_by, askerId],
  );
  if (own.rows.length > 0) return own.rows.map((r) => r.id);
  const admins = await query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.role IN ('admin', 'super_admin') AND ${activeMemberSql('u')} AND u.id <> $1`,
    [askerId],
  );
  return admins.rows.map((r) => r.id);
}

/** "{name} wants to join {circle}" for the people who answer asks, once an hour at most per asker. Never throws. */
async function ringManagers(circle: CircleRow, askerId: string): Promise<void> {
  try {
    const recipients = await managersToRing(circle, askerId);
    if (recipients.length === 0) return;
    const bell = {
      type: 'join_request',
      title: `${await displayNameOf(askerId)} wants to join ${circle.name}`,
      body: 'Approve or decline their request on the circle page.',
      link: `/circles/${circle.id}?requests=1`,
    };
    const rows = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT r.id, 'join_request', $2, $3, $4
         FROM unnest($1::uuid[]) AS r(id)
        WHERE NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.user_id = r.id AND n.type = 'join_request' AND n.link = $4 AND n.title = $2
                             AND n.created_at > NOW() - INTERVAL '1 hour')
       RETURNING id, user_id, created_at`,
      [recipients, bell.title, bell.body, bell.link],
    );
    await pushBells(rows.rows, bell);
  } catch (err) {
    logger.warn({ err, circleId: circle.id, askerId }, 'circle join request bell failed (non-fatal)');
  }
}

/** "You're in {circle}" for each person just let in. Never throws: the approval stands whatever the bell does. */
export async function ringApproved(circleId: string, circleName: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const bell = { type: 'approval', title: `You're in ${circleName}`, body: 'Your request to join was approved.', link: `/circles/${circleId}` };
    const rows = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT r.id, 'approval', $2, $3, $4 FROM unnest($1::uuid[]) AS r(id)
       RETURNING id, user_id, created_at`,
      [userIds, bell.title, bell.body, bell.link],
    );
    await pushBells(rows.rows, bell);
  } catch (err) {
    logger.warn({ err, circleId }, 'circle approval bell failed (non-fatal)');
  }
}

// ── Asking ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ask to join. An open circle, or someone who runs it, simply joins (status member). Someone already in it stays in.
 * A closed circle records one pending ask (a second while it waits adds nothing, `created` false) and rings its
 * managers once. 404 for a missing or archived circle.
 */
export async function requestToJoinCircle(
  circleId: string,
  userId: string,
  role?: string,
): Promise<CircleRequestResult & { created: boolean }> {
  const circle = await liveCircle(circleId);
  if (circle.join_policy !== 'closed' || (await isCircleManager(circleId, userId, role))) {
    await joinCircle(circleId, userId, { role });
    return { status: 'member', created: false };
  }
  if (await isCircleMember(circleId, userId)) return { status: 'member', created: false };

  const ins = await query<{ id: string }>(
    `INSERT INTO circle_join_requests (circle_id, user_id) VALUES ($1, $2)
     ON CONFLICT (circle_id, user_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [circleId, userId],
  );
  const created = ins.rows.length > 0;
  if (created) {
    logger.info({ circleId, userId }, 'Circle join requested');
    await ringManagers(circle, userId);
  }
  return { status: 'requested', created };
}

/** Withdraw your own waiting ask. `cancelled` false when there was none (a second press, or it was answered). */
export async function cancelJoinRequest(circleId: string, userId: string): Promise<{ cancelled: boolean }> {
  const r = await query(
    `UPDATE circle_join_requests SET status = 'cancelled', decided_by = $2, decided_at = NOW()
      WHERE circle_id = $1 AND user_id = $2 AND status = 'pending'`,
    [circleId, userId],
  );
  return { cancelled: !!r.rowCount && r.rowCount > 0 };
}

/** The asks waiting, oldest first, for the people who run the circle. Accounts that are not active are left out. */
export async function listJoinRequests(circleId: string, viewer: CircleActor): Promise<CircleJoinRequest[]> {
  await assertCircleManager(circleId, viewer.userId, viewer.role, 'Only the people who run this circle can see who asked to join.');
  const r = await query<{
    user_id: string; display_name: string | null; avatar_url: string | null;
    job_title: string | null; company: string | null; created_at: Date;
  }>(
    `SELECT r.user_id, u.display_name, u.avatar_url, u.job_title, u.company, r.created_at
       FROM circle_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.circle_id = $1 AND r.status = 'pending' AND ${activeMemberSql('u')}
      ORDER BY r.created_at ASC, r.user_id
      LIMIT ${REQUESTS_SHOWN}`,
    [circleId],
  );
  return r.rows.map((row) => ({
    userId: row.user_id, displayName: row.display_name, avatarUrl: row.avatar_url,
    jobTitle: row.job_title, company: row.company, requestedAt: new Date(row.created_at).toISOString(),
  }));
}

// ── Answering ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Approve or decline one waiting ask, under a lock on it: the person is let in (the count moving with the row) or
 * turned down in the same transaction, and a second answer to the same ask is a 404 in words. Only the people who
 * run the circle answer (403). An ask from an account that is no longer active cannot be answered.
 */
async function answer(circleId: string, requesterId: string, decider: CircleActor, approve: boolean): Promise<{ circleName: string }> {
  const circle = await assertCircleManager(circleId, decider.userId, decider.role, 'Only the people who run this circle can answer requests.');
  await transaction(async (client) => {
    const ask = await client.query<{ id: string }>(
      `SELECT r.id FROM circle_join_requests r JOIN users u ON u.id = r.user_id
        WHERE r.circle_id = $1 AND r.user_id = $2 AND r.status = 'pending' AND ${activeMemberSql('u')}
        FOR UPDATE OF r`,
      [circleId, requesterId],
    );
    if (!ask.rows[0]) throw new NotFoundError('CircleRequest', undefined, REQUEST_ALREADY_ANSWERED);
    if (approve) {
      await admitToCircle(client, circleId, requesterId, decider.userId);
    } else {
      await client.query(
        `UPDATE circle_join_requests SET status = 'declined', decided_by = $2, decided_at = NOW() WHERE id = $1`,
        [ask.rows[0].id, decider.userId],
      );
    }
  });
  logger.info({ circleId, requesterId, deciderId: decider.userId, approve }, 'Circle join request answered');
  return { circleName: circle.name };
}

export async function approveJoinRequest(circleId: string, requesterId: string, decider: CircleActor): Promise<void> {
  const { circleName } = await answer(circleId, requesterId, decider, true);
  await ringApproved(circleId, circleName, [requesterId]);
}

export async function declineJoinRequest(circleId: string, requesterId: string, decider: CircleActor): Promise<void> {
  await answer(circleId, requesterId, decider, false);
}

// ── Removing a member ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The people who run a circle remove a member ("same as Parts": a pod's director removes members). Never its
 * creator or an owner (403), and never yourself (you leave instead). The count moves in the same transaction. A
 * removed member of an open circle may join again; of a closed one, ask again.
 */
export async function removeCircleMember(circleId: string, memberId: string, actor: CircleActor): Promise<void> {
  const circle = await assertCircleManager(circleId, actor.userId, actor.role, 'Only the people who run this circle can remove members.');
  if (memberId === actor.userId) throw new ValidationError('To leave the circle, use Leave.');
  await transaction(async (client) => {
    const row = await client.query<{ role: string }>(
      `SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE`, [circleId, memberId]);
    if (!row.rows[0]) throw new NotFoundError('CircleMember', undefined, 'They are not in this circle.');
    if (row.rows[0].role === 'owner' || memberId === circle.createdBy) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, "The circle's owner can't be removed.");
    }
    await client.query(`DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, memberId]);
    await client.query(`UPDATE circles SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`, [circleId]);
  });
  logger.info({ circleId, memberId, actorId: actor.userId }, 'Circle member removed');
}

// ── The pods a manager may attach ────────────────────────────────────────────────────────────────────────────

/**
 * The attach picker's list (30 Oct review 7.6), a page at a time and searched by name: the pods the viewer runs (an
 * active director or host) or, for a platform admin, every pod; never an archived one or one already attached. Only
 * the people who run the circle ask it (403). The old picker read GET /pods, which stops at the first 20 of the
 * caller's own pods.
 */
export async function listAttachablePods(
  circleId: string,
  viewer: CircleActor,
  params: { q?: string; page: number; pageSize: number },
): Promise<CircleAttachablePodPage> {
  await assertCircleManager(circleId, viewer.userId, viewer.role, 'Only the people who run this circle can attach pods.');
  const pageSize = Math.min(Math.max(1, params.pageSize), ATTACHABLE_PAGE_MAX);
  const page = Math.max(1, params.page);
  const search = params.q?.trim() ? `%${escapeLike(params.q.trim())}%` : null;
  const r = await query<{ id: string; name: string; description: string | null; visibility: string; member_role: string | null }>(
    `SELECT p.id, p.name, p.description, p.visibility, pm.role AS member_role
       FROM pods p
       LEFT JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active'
      WHERE p.status <> 'archived'
        AND ($3::boolean OR pm.role IN ('director', 'host'))
        AND NOT EXISTS (SELECT 1 FROM circle_pods cp WHERE cp.circle_id = $1 AND cp.pod_id = p.id)
        AND ($4::text IS NULL OR p.name ILIKE $4)
      ORDER BY lower(p.name), p.id
      LIMIT $5 OFFSET $6`,
    [circleId, viewer.userId, isPlatformAdmin(viewer.role), search, pageSize + 1, (page - 1) * pageSize],
  );
  const items = r.rows.slice(0, pageSize).map((row) => ({
    podId: row.id, name: row.name, description: row.description, visibility: row.visibility, memberRole: row.member_role,
  }));
  return { items, nextPage: r.rows.length > pageSize ? page + 1 : null };
}
