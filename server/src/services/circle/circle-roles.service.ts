// ─── A circle's roles: moderators and handing the circle over (Shirley pilot S2, 11 Nov 2026; plan D3) ───────────
//
// "Give Shirley actual authority over Curious Humans" (brief RSN 02). A circle has one owner (migration 148's unique
// index), any number of moderators who run it with the owner, and members. Only the owner, or a platform admin:
//   - makes a member a moderator, or a moderator a member again (setCircleMemberRole);
//   - hands the circle to someone else in it (transferCircleOwnership): the new owner first must be in the circle and
//     hold an active member account; the old owner becomes a moderator, so they keep running it unless the new owner
//     changes that. The owner's own role never moves any other way.
// Every write locks the circle row first and reads the actor's role again under that lock, so two people acting at
// once are taken one after the other and the second acts on what the first left: an owner who has just handed the
// circle over can no longer change a role, and a second handover finds the new owner. Each change writes an
// audit_log row in the same transaction, and the routes tell everyone it touches (fanoutCircleChange).

import type { PoolClient } from 'pg';
import { transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../middleware/errors';
import { CircleAssignableRole, CircleRole, ErrorCodes } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';
import { OWNER_ONLY, isPlatformAdmin } from './circle-managers';

/** Who is acting, as the route knows them. */
export interface CircleActor {
  userId: string;
  role?: string;
}

export const NOT_IN_CIRCLE = 'They are not in this circle.';
export const OWNER_ROLE_FIXED = "The owner's role changes only when they hand the circle to someone else.";
export const NOT_ACTIVE_MEMBER = 'Only someone with an active REASON membership can run a circle.';
export const TRANSFER_NOT_MEMBER = 'Only someone in the circle can own it. Invite them first.';
export const ALREADY_OWNER = 'They already own this circle.';

interface LockedCircle { id: string; name: string }

/** Lock the live circle for this transaction (404 when it is missing or archived). */
async function lockCircle(client: PoolClient, circleId: string): Promise<LockedCircle> {
  const r = await client.query<LockedCircle>(
    `SELECT id, name FROM circles WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [circleId]);
  if (!r.rows[0]) throw new NotFoundError('Circle', circleId);
  return r.rows[0];
}

interface MemberFacts { user_id: string; role: CircleRole; active_member: boolean }

/** The rows of these people in the circle, locked, with whether each holds an active member account. */
async function lockMembers(client: PoolClient, circleId: string, userIds: string[]): Promise<Map<string, MemberFacts>> {
  const r = await client.query<MemberFacts>(
    `SELECT m.user_id, m.role, (${activeMemberSql('u')} AND u.account_kind = 'member') AS active_member
       FROM circle_members m JOIN users u ON u.id = m.user_id
      WHERE m.circle_id = $1 AND m.user_id = ANY($2::uuid[])
      FOR UPDATE OF m`,
    [circleId, [...new Set(userIds)]],
  );
  return new Map(r.rows.map((row) => [row.user_id, row]));
}

function assertOwnerPowers(actor: CircleActor, rows: Map<string, MemberFacts>): void {
  if (isPlatformAdmin(actor.role)) return;
  if (rows.get(actor.userId)?.role !== 'owner') throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, OWNER_ONLY);
}

async function audit(client: PoolClient, actorId: string, action: string, circleId: string, details: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'circle', $3, $4)`,
    [actorId, action, circleId, JSON.stringify(details)],
  );
}

export interface RoleChange { changed: boolean; circleName: string; from: CircleRole; to: CircleAssignableRole }

/**
 * Make a member a moderator, or a moderator a member (the owner or a platform admin). The person must be in the
 * circle (404 in words), never its owner (409), and a new moderator must hold an active member account (400; stepping
 * someone down needs no such thing). Asking for the role they already hold changes nothing (`changed` false).
 */
export async function setCircleMemberRole(
  circleId: string,
  targetId: string,
  role: CircleAssignableRole,
  actor: CircleActor,
): Promise<RoleChange> {
  const result = await transaction(async (client) => {
    const circle = await lockCircle(client, circleId);
    const rows = await lockMembers(client, circleId, [targetId, actor.userId]);
    assertOwnerPowers(actor, rows);
    const target = rows.get(targetId);
    if (!target) throw new NotFoundError('CircleMember', undefined, NOT_IN_CIRCLE);
    if (target.role === 'owner') throw new ConflictError(ErrorCodes.VALIDATION_ERROR, OWNER_ROLE_FIXED);
    if (target.role === role) return { changed: false, circleName: circle.name, from: target.role, to: role };
    if (role === 'moderator' && !target.active_member) throw new ValidationError(NOT_ACTIVE_MEMBER);
    await client.query(
      `UPDATE circle_members SET role = $3 WHERE circle_id = $1 AND user_id = $2`, [circleId, targetId, role]);
    await audit(client, actor.userId, 'circle_role_change', circleId, { userId: targetId, from: target.role, to: role });
    return { changed: true, circleName: circle.name, from: target.role, to: role };
  });
  if (result.changed) logger.info({ circleId, targetId, from: result.from, to: role, actorId: actor.userId }, 'Circle role changed');
  return result;
}

export interface Handover { circleName: string; previousOwnerId: string | null }

/**
 * Hand the circle to someone else in it (its owner, or a platform admin). The new owner must be in the circle (400,
 * "invite them first") and hold an active member account (400); handing it to its owner is a 409. The old owner (if
 * the circle has one) becomes a moderator BEFORE the new owner is made owner, in one transaction, so the one-owner
 * index never sees two. A platform admin may give an ownerless circle an owner the same way.
 */
export async function transferCircleOwnership(circleId: string, toUserId: string, actor: CircleActor): Promise<Handover> {
  const result = await transaction(async (client) => {
    const circle = await lockCircle(client, circleId);
    const owner = await client.query<{ user_id: string }>(
      `SELECT user_id FROM circle_members WHERE circle_id = $1 AND role = 'owner' FOR UPDATE`, [circleId]);
    const previousOwnerId = owner.rows[0]?.user_id ?? null;
    const rows = await lockMembers(client, circleId, [toUserId, actor.userId]);
    assertOwnerPowers(actor, rows);
    if (previousOwnerId === toUserId) throw new ConflictError(ErrorCodes.VALIDATION_ERROR, ALREADY_OWNER);
    const target = rows.get(toUserId);
    if (!target) throw new ValidationError(TRANSFER_NOT_MEMBER);
    if (!target.active_member) throw new ValidationError(NOT_ACTIVE_MEMBER);
    if (previousOwnerId) {
      await client.query(
        `UPDATE circle_members SET role = 'moderator' WHERE circle_id = $1 AND user_id = $2 AND role = 'owner'`,
        [circleId, previousOwnerId]);
    }
    await client.query(
      `UPDATE circle_members SET role = 'owner' WHERE circle_id = $1 AND user_id = $2`, [circleId, toUserId]);
    await audit(client, actor.userId, 'circle_ownership_transfer', circleId,
      { from: previousOwnerId, to: toUserId, previousOwnerBecomes: previousOwnerId ? 'moderator' : null });
    return { circleName: circle.name, previousOwnerId };
  });
  logger.info({ circleId, from: result.previousOwnerId, to: toUserId, actorId: actor.userId }, 'Circle handed over');
  return result;
}
