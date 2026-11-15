// ─── Asking for a new circle (Ben field test, 13 Nov 2026) ─────────────────────────────────────────────────────────
//
// "Not everyone needs a Circle. A Circle represents a real community or organisation." Request, review, approve,
// create: a member asks for a circle (its name, what it is, why it should exist, who can join), every platform admin is
// told, and one of them approves or declines. Only an approved ask makes a circle, in the same transaction as the
// answer, with the member who asked as its owner and the policy they chose written with the row (circle.service.ts
// insertCircle). Platform admins still make circles directly from the Circles page; that is the same decision.
//
// Every answer is taken under a row lock on the ask, so two admins pressing at once make one decision: the second is
// told it was already answered. A member may have at most MAX_WAITING asks waiting, and one per name.

import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { config } from '../../config';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../middleware/errors';
import {
  CircleCreationRequest, CircleCreationRequestForReview, CircleCreationRequestStatus, CircleJoinPolicy, ErrorCodes,
} from '@rsn/shared';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { fanoutAdminEntities, fanoutCircleChange } from '../../realtime/fanout';
import { activeMemberSql } from '../users/active-member';
import { CIRCLE_NAME_TAKEN, assertNewCircleShape, insertCircle } from './circle.service';
import { readJoinPolicy } from './circle-managers';
import { isEmailTypeEnabled, sendGenericEmail } from '../email/email.service';

/** A member's asks that may wait for an answer at once. */
export const MAX_WAITING = 3;
/** How many of a member's own asks their list shows (newest first). */
const OWN_SHOWN = 20;
/** How many asks the admins' queue shows at once (oldest first); more appear as these are answered. */
const QUEUE_SHOWN = 100;

export const ALREADY_ANSWERED = 'This circle request has already been answered.';
export const TOO_MANY_WAITING = `You already have ${MAX_WAITING} circle requests waiting. You can ask for another once one is answered.`;
export const SAME_NAME_WAITING = 'You have already asked for a circle with this name. It is waiting for an answer.';
export const REQUESTER_GONE = "The member who asked for this circle no longer has an active account, so it can't be approved. Decline it instead.";

export interface NewCircleRequestInput {
  name: string;
  description?: string | null;
  purpose: string;
  joinPolicy?: CircleJoinPolicy;
}

interface RequestRow {
  id: string;
  requester_id: string;
  name: string;
  description: string | null;
  purpose: string;
  join_policy: string;
  status: CircleCreationRequestStatus;
  decline_reason: string | null;
  circle_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const REQUEST_COLUMNS = `r.id, r.requester_id, r.name, r.description, r.purpose, r.join_policy, r.status,
  r.decline_reason, r.circle_id, r.created_at, r.decided_at`;

function toRequest(row: RequestRow): CircleCreationRequest {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    purpose: row.purpose,
    joinPolicy: readJoinPolicy(row.join_policy),
    status: row.status,
    declineReason: row.decline_reason,
    circleId: row.circle_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

// ── Asking ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A member asks for a new circle. Refused for an account that is not an active member's (a guest from an event link
 * has no circles), past MAX_WAITING waiting asks, for a second waiting ask with the same name, and for a name a live
 * top-level circle already has. Rings every platform admin once.
 */
export async function requestCircle(userId: string, input: NewCircleRequestInput): Promise<CircleCreationRequest> {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  if (name.length < 2) throw new ValidationError('Give the circle a name of at least 2 characters.');
  if (purpose.length < 10) throw new ValidationError('Say in a sentence who the circle is for and why it should exist.');

  const asker = await query<{ display_name: string | null }>(
    `SELECT u.display_name FROM users u WHERE u.id = $1 AND ${activeMemberSql('u')} AND u.account_kind = 'member'`,
    [userId]);
  if (!asker.rows[0]) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Only members can ask for a new circle.');

  const taken = await query(
    `SELECT 1 FROM circles WHERE parent_circle_id IS NULL AND archived_at IS NULL AND lower(name) = lower($1)`, [name]);
  if (taken.rows.length > 0) throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_REFUSED, 'A circle with that name already exists. Ask to join it, or choose another name.');

  const inserted = await transaction(async (client) => {
    // One member's asks are counted under a lock on their own user row, so two asks sent at once cannot both pass.
    await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const waiting = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM circle_creation_requests WHERE requester_id = $1 AND status = 'pending'`, [userId]);
    if ((waiting.rows[0]?.n ?? 0) >= MAX_WAITING) throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_REFUSED, TOO_MANY_WAITING);
    const r = await client.query<RequestRow>(
      `INSERT INTO circle_creation_requests AS r (requester_id, name, description, purpose, join_policy)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (requester_id, lower(name)) WHERE status = 'pending' DO NOTHING
       RETURNING ${REQUEST_COLUMNS}`,
      [userId, name, input.description?.trim() || null, purpose, input.joinPolicy ?? 'closed'],
    );
    if (!r.rows[0]) throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_REFUSED, SAME_NAME_WAITING);
    return r.rows[0];
  });

  logger.info({ requestId: inserted.id, userId, name }, 'Circle requested');
  await ringAdmins(asker.rows[0].display_name?.trim() || 'A member', name);
  await tellAboutRequest(userId);
  return toRequest(inserted);
}

/** A member's own asks, newest first. */
export async function listOwnRequests(userId: string): Promise<CircleCreationRequest[]> {
  const r = await query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM circle_creation_requests r
      WHERE r.requester_id = $1 ORDER BY r.created_at DESC, r.id LIMIT ${OWN_SHOWN}`,
    [userId]);
  return r.rows.map(toRequest);
}

/** A member withdraws their own waiting ask. 404 for someone else's; 409 once it has been answered. */
export async function cancelOwnRequest(userId: string, requestId: string): Promise<void> {
  const r = await query<{ status: string }>(
    `UPDATE circle_creation_requests SET status = 'cancelled', decided_by = $2, decided_at = NOW()
      WHERE id = $1 AND requester_id = $2 AND status = 'pending'
      RETURNING status`,
    [requestId, userId]);
  if (r.rows[0]) {
    await tellAboutRequest(userId);
    return;
  }
  const exists = await query(`SELECT 1 FROM circle_creation_requests WHERE id = $1 AND requester_id = $2`, [requestId, userId]);
  if (!exists.rows[0]) throw new NotFoundError('CircleRequest', requestId, "We couldn't find that circle request.");
  throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_ALREADY_ANSWERED, ALREADY_ANSWERED);
}

// ── Reviewing (platform admins; the route asks requireRole) ────────────────────────────────────────────────────

/** The asks waiting, oldest first, with who asked. Asks from accounts that are no longer active are left out. */
export async function listPendingForReview(): Promise<CircleCreationRequestForReview[]> {
  const r = await query<RequestRow & {
    display_name: string | null; avatar_url: string | null; job_title: string | null; company: string | null;
  }>(
    `SELECT ${REQUEST_COLUMNS}, u.display_name, u.avatar_url, u.job_title, u.company
       FROM circle_creation_requests r
       JOIN users u ON u.id = r.requester_id
      WHERE r.status = 'pending' AND ${activeMemberSql('u')}
      ORDER BY r.created_at, r.id
      LIMIT ${QUEUE_SHOWN}`);
  return r.rows.map((row) => ({
    ...toRequest(row),
    requester: {
      userId: row.requester_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      jobTitle: row.job_title,
      company: row.company,
    },
  }));
}

/** The waiting ask, locked for this transaction; 409 when it was answered or withdrawn, 404 when there is none. */
async function lockPending(client: PoolClient, requestId: string): Promise<RequestRow> {
  const r = await client.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM circle_creation_requests r WHERE r.id = $1 FOR UPDATE`, [requestId]);
  const row = r.rows[0];
  if (!row) throw new NotFoundError('CircleRequest', requestId, "We couldn't find that circle request.");
  if (row.status !== 'pending') throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_ALREADY_ANSWERED, ALREADY_ANSWERED);
  return row;
}

async function auditRequest(client: PoolClient, actorId: string, action: string, requestId: string, details: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'circle_request', $3, $4)`,
    [actorId, action, requestId, JSON.stringify(details)]);
}

/**
 * Approve: the circle is made, with the member who asked as its owner and the policy they chose, in the same
 * transaction as the answer. The admin may give it another name (`name`), for a clash or a clearer one. Refused when
 * the member's account is no longer active (decline it instead) and when the name is taken.
 */
export async function approveRequest(adminId: string, requestId: string, opts: { name?: string } = {}): Promise<{ circleId: string }> {
  let requesterId = '';
  let circleName = '';
  try {
    const circleId = await transaction(async (client) => {
      const row = await lockPending(client, requestId);
      const active = await client.query(
        `SELECT 1 FROM users u WHERE u.id = $1 AND ${activeMemberSql('u')}`, [row.requester_id]);
      if (!active.rows[0]) throw new ConflictError(ErrorCodes.CIRCLE_REQUEST_REFUSED, REQUESTER_GONE);
      const name = opts.name?.trim() || row.name;
      await assertNewCircleShape({ name });
      const made = await insertCircle(client, row.requester_id, {
        name, description: row.description, joinPolicy: readJoinPolicy(row.join_policy),
      });
      await client.query(
        `UPDATE circle_creation_requests
            SET status = 'approved', decided_by = $2, decided_at = NOW(), circle_id = $3, name = $4
          WHERE id = $1`,
        [requestId, adminId, made.id, name]);
      await auditRequest(client, adminId, 'circle_request_approved', requestId,
        { circleId: made.id, requesterId: row.requester_id, name, renamedFrom: name !== row.name ? row.name : null });
      requesterId = row.requester_id;
      circleName = name;
      return made.id;
    });
    logger.info({ requestId, circleId, adminId, requesterId }, 'Circle request approved');
    void fanoutCircleChange(circleId, adminId, [requesterId]);
    await tellRequester(requesterId, {
      title: 'Your circle is live',
      body: `${circleName} has been approved. You are its owner.`,
      link: `/circles/${circleId}`,
      email: `Good news: ${circleName} has been approved and is now live on REASON. You are its owner, so you choose who `
        + `can join and who helps you run it.\n\nOpen it here: ${config.clientUrl}/circles/${circleId}`,
    });
    return { circleId };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, `${CIRCLE_NAME_TAKEN}. Give it another name, or decline it.`);
    }
    throw err;
  }
}

/** Decline, with the admin's reason when they give one (the member sees it). */
export async function declineRequest(adminId: string, requestId: string, opts: { reason?: string } = {}): Promise<void> {
  const reason = opts.reason?.trim() || null;
  const row = await transaction(async (client) => {
    const locked = await lockPending(client, requestId);
    await client.query(
      `UPDATE circle_creation_requests
          SET status = 'declined', decided_by = $2, decided_at = NOW(), decline_reason = $3
        WHERE id = $1`,
      [requestId, adminId, reason]);
    await auditRequest(client, adminId, 'circle_request_declined', requestId,
      { requesterId: locked.requester_id, name: locked.name, reason });
    return locked;
  });
  logger.info({ requestId, adminId, requesterId: row.requester_id }, 'Circle request declined');
  await tellRequester(row.requester_id, {
    title: 'Your circle request',
    body: reason ? `${row.name} was not approved: ${reason}` : `${row.name} was not approved this time.`,
    link: '/circles',
    email: `Thank you for asking for ${row.name}. It was not approved this time.`
      + (reason ? `\n\nThe reason given: ${reason}` : '')
      + '\n\nYou can still join the circles that exist, or ask again with more about who the circle is for.',
  });
}

// ── Telling people ─────────────────────────────────────────────────────────────────────────────────────────────

/** The admins' queue and each admin's bell. Never throws: the ask is already saved. */
async function ringAdmins(askerName: string, circleName: string): Promise<void> {
  try {
    const rung = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at)
       SELECT u.id, 'circle_request', 'New circle request', $1, '/admin/circle-requests', NOW()
         FROM users u WHERE u.role IN ('admin', 'super_admin') AND ${activeMemberSql('u')}
       RETURNING id, user_id, created_at`,
      [`${askerName} asked for a circle: ${circleName}`]);
    const io = getRealtimeIo();
    if (io) {
      for (const row of rung.rows) {
        io.to(`user:${row.user_id}`).emit('notification:new', {
          id: row.id, type: 'circle_request', title: 'New circle request', body: `${askerName} asked for a circle: ${circleName}`,
          link: '/admin/circle-requests', isRead: false, createdAt: row.created_at,
        });
      }
      await Promise.all(rung.rows.map((row) => emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)])));
    }
  } catch (err) {
    logger.warn({ err }, 'circle request: the admins were not rung (non-fatal)');
  }
  await fanoutAdminEntities('circle-requests');
}

/** The member's own list changed (asked, withdrew): their list and the admins' queue. */
async function tellAboutRequest(userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (io) {
    try {
      await emitEntities(io, [userId], [E.userCircleRequests(userId)]);
    } catch (err) {
      logger.warn({ err, userId }, 'circle request: the member\'s list was not told (non-fatal)');
    }
  }
  await fanoutAdminEntities('circle-requests');
}

/** The answer: the member's bell, list and email, and the admins' queue. Never throws: the answer is already saved. */
async function tellRequester(userId: string, msg: { title: string; body: string; link: string; email: string }): Promise<void> {
  try {
    const bell = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at)
       VALUES ($1, 'circle_request_answered', $2, $3, $4, NOW()) RETURNING id, created_at`,
      [userId, msg.title, msg.body, msg.link]);
    const io = getRealtimeIo();
    if (io && bell.rows[0]) {
      io.to(`user:${userId}`).emit('notification:new', {
        id: bell.rows[0].id, type: 'circle_request_answered', title: msg.title, body: msg.body, link: msg.link,
        isRead: false, createdAt: bell.rows[0].created_at,
      });
      await emitEntities(io, [userId], [E.userNotifications(userId), E.userCircleRequests(userId)]);
    }
  } catch (err) {
    logger.warn({ err, userId }, 'circle request: the member was not rung (non-fatal)');
  }
  await fanoutAdminEntities('circle-requests');
  try {
    if (!(await isEmailTypeEnabled('circle_request_answered'))) return;
    const u = await query<{ email: string | null; display_name: string | null }>(
      `SELECT u.email, u.display_name FROM users u WHERE u.id = $1 AND ${activeMemberSql('u')}`, [userId]);
    const to = u.rows[0]?.email;
    if (!to) return;
    await sendGenericEmail(to, u.rows[0].display_name?.trim() || 'there', { subject: msg.title, body: msg.email });
  } catch (err) {
    logger.warn({ err, userId }, 'circle request: the answer email was not sent (non-fatal)');
  }
}
