// ─── Circle Service ──────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). A circle is a COMMUNITY (people with the
// same intent/type — Stefan's definition); pods are ACTIVITY containers
// attached to circles many-to-many. Admin-created v1; open join (flagged
// default); membership gates nothing except (later) wall posting.
//
// Architecture: docs/superpowers/plans/2026-07-19-circles-wall-architecture.md
// Rules enforced here rather than in SQL: nesting cycle rejection + depth cap
// (Postgres can't CHECK graph properties; writes are admin-only so this is
// contention-free).

import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError, ValidationError } from '../../middleware/errors';
import { CircleAccess, CircleEntityLink, CircleJoinPolicy, ErrorCodes, UserRole, eventZone, hasRoleAtLeast } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';
import { visibleEventsSql } from '../session/event-access';
import { eventImageColumns, eventImageUrlOf } from '../session/event-image-url';
import {
  CircleAccessRow, circleAccessColumns, isCircleManager, isPlatformAdmin, toCircleAccess,
} from './circle-managers';
import { entitiesOfCircle } from './circle-entities.service';
import type { ReturningInvite } from '../pod/pod.service';

/** What joinCircle answers someone outside a closed circle (30 Oct review, 7.5). */
export const CIRCLE_CLOSED_JOIN = 'This circle is closed. Ask to join and its owner will let you in.';
/** An invite whose maker no longer runs the circle, accepted after it closed (final fix wave S2, 2 Nov 2026). */
export const CIRCLE_CLOSED_INVITE = 'This circle is closed now, so this invite no longer lets you in. Ask to join and its owner will let you in.';

/**
 * T14 (1 Nov 2026): an attached pod is named on a circle's page only when it is not archived and, if private, only to
 * its active members (and platform admins, `$admin`). `pod` is the pods alias, `viewer` and `admin` parameters.
 * S2 (D2): an old "invite only" row reads as private (migration 148 maps them; this holds for any it missed).
 */
const NOT_DISCOVERABLE = `('private', 'invite_only')`;
const visiblePodSql = (pod: string, viewer: string, admin: string) => `${pod}.status <> 'archived'
  AND (${admin}::boolean OR ${pod}.visibility::text NOT IN ${NOT_DISCOVERABLE}
       OR EXISTS (SELECT 1 FROM pod_members vp_m WHERE vp_m.pod_id = ${pod}.id AND vp_m.user_id = ${viewer} AND vp_m.status = 'active'))`;

export const MAX_NESTING_DEPTH = 3;

/**
 * T2 (1 Nov 2026): a circle's member count as members see it, the members list's own rule (an account an admin
 * removed, suspended or banned is neither listed nor counted). `circleAlias` is the query's alias for circles.
 * The stored member_count counter still moves on join and leave; it is no longer what anyone reads.
 */
const activeCircleMemberCount = (circleAlias: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(circleAlias)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Not a table alias: ${JSON.stringify(circleAlias)}`);
  }
  return `(SELECT count(*)::int FROM circle_members cm_n
    JOIN users cm_u ON cm_u.id = cm_n.user_id
   WHERE cm_n.circle_id = ${circleAlias}.id AND ${activeMemberSql('cm_u')})`;
};

/** T14: every read adds the viewer's CircleAccess (joinPolicy, myStatus, canManage, canInvite, requestCount, locked). */
export interface CircleSummary extends CircleAccess {
  id: string;
  name: string;
  description: string | null;
  parentCircleId: string | null;
  memberCount: number;
  podCount: number;
  isMember: boolean;
  createdAt: Date;
}

/**
 * A locked circle (closed, and the viewer is neither in it nor runs it) sends no members, pods or events: the arrays
 * are empty. Its name, description, counts and child circles still read.
 */
export interface CircleDetail extends CircleSummary {
  members: Array<{
    userId: string; displayName: string | null; avatarUrl: string | null;
    role: string; joinedAt: Date;
  }>;
  /** S2 (additive): each pod's visibility, so the page says which pods are private or need approval. */
  pods: Array<{ podId: string; name: string; description: string | null; visibility: string }>;
  /**
   * T13: `forCircle` (additive) is true for an event made for this circle, false for an attached pod's event.
   * Part 3 Task 1 (additive): each event's IANA zone (its time reads on that clock) and its image (null: none).
   */
  upcomingEvents: Array<{
    id: string; title: string; scheduledAt: Date; podId: string; forCircle: boolean; timezone: string; imageUrl: string | null;
  }>;
  children: Array<{ id: string; name: string; memberCount: number }>;
  /** T15 (additive): the entities linked to it (at most 50, none archived); empty on a locked circle. */
  entities: CircleEntityLink[];
}

// ── Nesting integrity ────────────────────────────────────────────────────────

/**
 * Walk ancestors of `parentId`; reject if `circleId` appears (cycle) or the
 * chain exceeds MAX_NESTING_DEPTH. Admin-only writes → no lock contention.
 */
async function assertValidParent(parentId: string, circleId: string | null): Promise<void> {
  let cursor: string | null = parentId;
  let depth = 1;
  while (cursor) {
    if (circleId !== null && cursor === circleId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A circle cannot contain itself');
    }
    if (depth > MAX_NESTING_DEPTH) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Circles can nest at most ${MAX_NESTING_DEPTH} levels deep`);
    }
    const r: { rows: Array<{ parent_circle_id: string | null }> } = await query(
      `SELECT parent_circle_id FROM circles WHERE id = $1 AND archived_at IS NULL`,
      [cursor],
    );
    if (r.rows.length === 0) throw new NotFoundError('Circle', cursor);
    cursor = r.rows[0].parent_circle_id;
    depth++;
  }
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────

export async function createCircle(
  adminUserId: string,
  input: { name: string; description?: string | null; parentCircleId?: string | null },
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Circle name must be at least 2 characters');
  }
  if (input.parentCircleId) await assertValidParent(input.parentCircleId, null);

  try {
    // The creator is the circle's owner from the first moment, in the same transaction as the circle row, so the
    // circle never exists without the person who runs it and member_count matches the member rows (1 Nov 2026, L21).
    const created = await transaction(async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO circles (name, description, parent_circle_id, created_by, member_count)
         VALUES ($1, $2, $3, $4, 1) RETURNING id`,
        [name, input.description?.trim() || null, input.parentCircleId ?? null, adminUserId],
      );
      await client.query(
        `INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [r.rows[0].id, adminUserId],
      );
      return r.rows[0];
    });
    logger.info({ circleId: created.id, name, adminUserId }, 'Circle created');
    return created;
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A circle with that name already exists here');
    }
    throw err;
  }
}

/** Who is editing a circle, as the route knows them. Absent: a platform admin (production's admin-only route). */
export interface CircleActor {
  userId: string;
  role?: string;
}

/**
 * Edit a circle. Its managers (T14) may change its name, description and who can join; moving it under another
 * circle stays a platform admin's (it reaches into a circle they may not run). Opening a closed circle lets everyone
 * still waiting in, in the same transaction, and answers with who that was (the route rings and tells them).
 */
export async function updateCircle(
  circleId: string,
  input: { name?: string; description?: string | null; parentCircleId?: string | null; joinPolicy?: CircleJoinPolicy },
  actor?: CircleActor,
): Promise<{ approvedUserIds: string[]; invitesChangedFor?: string[] }> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (existing.rows.length === 0) throw new NotFoundError('Circle', circleId);
  if (actor && input.parentCircleId !== undefined && !isPlatformAdmin(actor.role)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Only a platform admin can move a circle inside another one.');
  }

  if (input.parentCircleId) await assertValidParent(input.parentCircleId, circleId);

  const sets: string[] = [];
  const params: unknown[] = [circleId];
  if (input.name !== undefined) { params.push(input.name.trim()); sets.push(`name = $${params.length}`); }
  if (input.description !== undefined) { params.push(input.description?.trim() || null); sets.push(`description = $${params.length}`); }
  if (input.parentCircleId !== undefined) { params.push(input.parentCircleId); sets.push(`parent_circle_id = $${params.length}`); }
  if (input.joinPolicy !== undefined) { params.push(input.joinPolicy); sets.push(`join_policy = $${params.length}`); }
  if (!sets.length) return { approvedUserIds: [] };
  // A closed circle's events carry a tail on their links, an open one's may not: put right after the change, in the
  // background, telling each event's organisers (event-link.service.ts).
  const refreshLinks = () => {
    if (input.joinPolicy === undefined) return;
    void import('../session/event-link.service').then((links) => links.refreshEventLinksOf({ circleId }))
      .catch((err) => logger.warn({ err, circleId }, 'updateCircle: the event links were not brought up to date'));
  };
  try {
    const changed = await transaction(async (client) => {
      await client.query(`UPDATE circles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
      if (input.joinPolicy === 'closed') {
        return { approvedUserIds: [], invitesChangedFor: await withdrawInvitesOfNonManagers(client, circleId) };
      }
      if (input.joinPolicy !== 'open') return { approvedUserIds: [] };
      return { approvedUserIds: await admitEveryoneWaiting(client, circleId, actor?.userId ?? null) };
    });
    refreshLinks();
    return changed;
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A circle with that name already exists here');
    }
    throw err;
  }
}

/**
 * Closing a circle (final fix wave S2, 2 Nov 2026; L22): an invite lets its person straight in, and in a closed circle
 * only the people who run it may make one. So the invites still usable that were made by anyone else (a plain member's
 * open link from while it was open, a moderator's who has stepped down, a closed account's) are withdrawn, in the
 * caller's transaction. Invites from its owner and moderators and platform admins, all with active accounts, stand
 * (S2: having made the circle is no longer a reason). Answers the people whose invite lists changed: each inviter, and each invitee who is a member.
 */
async function withdrawInvitesOfNonManagers(client: PoolClient, circleId: string): Promise<string[]> {
  const r = await client.query<{ inviter_id: string; invitee_id: string | null }>(
    `UPDATE invites i SET status = 'revoked'
       FROM circles c
      WHERE i.circle_id = $1 AND c.id = i.circle_id
        AND i.status IN ('pending', 'accepted') AND i.use_count < i.max_uses
        AND NOT EXISTS (
          SELECT 1 FROM users a
           WHERE a.id = i.inviter_id AND ${activeMemberSql('a')}
             AND (a.role IN ('admin', 'super_admin')
                  OR EXISTS (SELECT 1 FROM circle_members m
                              WHERE m.circle_id = c.id AND m.user_id = a.id AND m.role IN ('owner', 'moderator'))))
      RETURNING i.inviter_id, (SELECT u.id FROM users u WHERE lower(u.email) = i.invitee_email LIMIT 1) AS invitee_id`,
    [circleId],
  );
  return [...new Set(r.rows.flatMap((row) => [row.inviter_id, row.invitee_id]).filter((id): id is string => !!id))];
}

/**
 * Reopening a circle (30 Oct review 7.5, the audit's default): every pending ask from an active account is approved
 * and its person joins, the stored count moving by the rows actually added. Asks from accounts that are not active
 * stay pending and unseen. Runs inside the caller's transaction; answers who was let in.
 */
async function admitEveryoneWaiting(client: PoolClient, circleId: string, deciderId: string | null): Promise<string[]> {
  const waiting = await client.query<{ user_id: string }>(
    `UPDATE circle_join_requests r SET status = 'approved', decided_by = $2, decided_at = NOW()
       FROM users u
      WHERE r.circle_id = $1 AND r.status = 'pending' AND u.id = r.user_id AND ${activeMemberSql('u')}
        AND u.account_kind = 'member'
      RETURNING r.user_id`,
    [circleId, deciderId],
  );
  const ids = waiting.rows.map((r) => r.user_id);
  if (ids.length === 0) return [];
  const added = await client.query(
    `INSERT INTO circle_members (circle_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [circleId, ids],
  );
  if (added.rowCount && added.rowCount > 0) {
    await client.query(`UPDATE circles SET member_count = member_count + $2 WHERE id = $1`, [circleId, added.rowCount]);
  }
  await client.query(`DELETE FROM circle_removals WHERE circle_id = $1 AND user_id = ANY($2::uuid[])`, [circleId, ids]);
  return ids;
}

/** Archive, never delete — every member/post row survives (spec §6). */
export async function archiveCircle(circleId: string): Promise<void> {
  const r = await query(
    `UPDATE circles SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (r.rowCount === 0) throw new NotFoundError('Circle', circleId);
}

// ── Pod attachment (admin) ───────────────────────────────────────────────────

/**
 * Attach a pod to a circle. The route has already checked the caller runs the circle. T14 (30 Oct review 7.6): a
 * platform admin attaches any pod; anyone else only a pod they run (its active director or host), so a pod is never
 * shown on a circle by someone with no say over it.
 */
export async function attachPod(circleId: string, podId: string, userId: string, isAdmin = true): Promise<void> {
  const circle = await query(`SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  const pod = await query<{ id: string; runs: boolean }>(
    `SELECT p.id, EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2
                            AND pm.status = 'active' AND pm.role IN ('director', 'host')) AS runs
       FROM pods p WHERE p.id = $1`,
    [podId, userId],
  );
  if (pod.rows.length === 0) throw new NotFoundError('Pod', podId);
  if (!isAdmin && !pod.rows[0].runs) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You can attach a pod you direct or host.');
  }
  await query(
    `INSERT INTO circle_pods (circle_id, pod_id, added_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [circleId, podId, userId],
  );
}

/** What anyone else is told on trying to take a pod out of a circle. */
export const DETACH_REFUSAL = "Only the people who run this circle, or the pod's director, can take a pod out of it.";

/**
 * Take a pod out of a circle (S2, brief RSN 03): the people who run the circle, or the pod's own active director (who
 * may always unlink their pod from any circle, run by them or not), or a platform admin. Only the link goes: the pod
 * keeps its members, settings, wall and events. 404 for a missing or archived circle; a link that was not there
 * changes nothing (`detached` false).
 */
export async function detachPod(circleId: string, podId: string, actor: CircleActor): Promise<{ detached: boolean }> {
  const r = await query<{ manages: boolean; directs: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $3
                       AND m.role IN ('owner', 'moderator')) AS manages,
            EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = $2 AND pm.user_id = $3
                       AND pm.status = 'active' AND pm.role = 'director') AS directs
       FROM circles c WHERE c.id = $1 AND c.archived_at IS NULL`,
    [circleId, podId, actor.userId],
  );
  const facts = r.rows[0];
  if (!facts) throw new NotFoundError('Circle', circleId);
  if (!isPlatformAdmin(actor.role) && !facts.manages && !facts.directs) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, DETACH_REFUSAL);
  }
  const del = await query(`DELETE FROM circle_pods WHERE circle_id = $1 AND pod_id = $2`, [circleId, podId]);
  return { detached: !!del.rowCount && del.rowCount > 0 };
}

// ── Membership (open join — flagged default, spec §10) ───────────────────────

/**
 * Add someone to a circle inside the caller's transaction, and answer any ask of theirs that is still waiting as
 * approved (an invite or a join is the answer to it). The counter moves in the SAME transaction as the membership row,
 * and only when a row was actually inserted, so a double-join can't double-count. True when they were added.
 */
export async function admitToCircle(client: PoolClient, circleId: string, userId: string, deciderId: string | null = null): Promise<boolean> {
  // Part 2 Task 6: an event guest (users.account_kind = 'event_guest') never becomes a circle member, whatever path
  // brought them here (a join, an invite, an approval): circles are for members. The row is simply not written.
  const ins = await client.query(
    `INSERT INTO circle_members (circle_id, user_id)
     SELECT $1, u.id FROM users u WHERE u.id = $2 AND u.account_kind = 'member'
     ON CONFLICT DO NOTHING`,
    [circleId, userId],
  );
  const added = !!ins.rowCount && ins.rowCount > 0;
  if (added) {
    await client.query(
      `UPDATE circles SET member_count = member_count + 1 WHERE id = $1`, [circleId]);
  }
  // S2 fix round 1: let back in, so no longer "removed" (an organiser approved, invited or reopened for them).
  await client.query(`DELETE FROM circle_removals WHERE circle_id = $1 AND user_id = $2`, [circleId, userId]);
  await client.query(
    `UPDATE circle_join_requests SET status = 'approved', decided_by = $3, decided_at = NOW()
      WHERE circle_id = $1 AND user_id = $2 AND status = 'pending'`,
    [circleId, userId, deciderId],
  );
  return added;
}

/** Whether the person who made an invite still runs the circle: an active account that manages it (L21). */
async function inviterRunsCircle(circleId: string, inviterId: string): Promise<boolean> {
  const r = await query<{ role: string }>(`SELECT u.role FROM users u WHERE u.id = $1 AND ${activeMemberSql('u')}`, [inviterId]);
  if (!r.rows[0]) return false;
  return isCircleManager(circleId, inviterId, r.rows[0].role);
}

/**
 * Join a circle. An open circle takes anyone at once (as always). A closed one (T14) takes only the people who run it
 * and anyone arriving with an invite from someone who still runs it (`invitedBy`, the invite's maker: the invite is the
 * doorway, and it answers a pending ask; final fix wave S2, 2 Nov 2026). Anyone else is told to ask, 403 CIRCLE_CLOSED,
 * and an invite whose maker does not run it says so. Someone already in it is left as they are.
 */
export async function joinCircle(
  circleId: string,
  userId: string,
  opts: { role?: string; invitedBy?: string; invite?: ReturningInvite } = {},
): Promise<void> {
  const circle = await query<{ id: string; join_policy: CircleJoinPolicy | null }>(
    `SELECT id, join_policy FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  const closed = circle.rows[0].join_policy === 'closed';

  // S2 fix round 1 (controller ruling): someone the circle's organisers removed does not come back by themselves. An
  // open circle refuses their own join; a closed one tells them to ask (an organiser decides). Only a personal invite
  // made after the removal by someone who runs the circle now lets them straight back in. Platform admins are exempt.
  if (!isPlatformAdmin(opts.role) && !(await isCircleMember(circleId, userId))) {
    const removedAt = await circleRemovalOf(circleId, userId);
    if (removedAt && !(await organiserInvitedBack(circleId, removedAt, opts))) {
      if (closed) throw new AppError(403, ErrorCodes.CIRCLE_CLOSED, CIRCLE_CLOSED_JOIN);
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, REMOVED_FROM_CIRCLE);
    }
  }

  if (closed
      && !(await isCircleMember(circleId, userId)) && !(await isCircleManager(circleId, userId, opts.role))
      && !(opts.invitedBy !== undefined && await inviterRunsCircle(circleId, opts.invitedBy))) {
    throw new AppError(403, ErrorCodes.CIRCLE_CLOSED, opts.invitedBy !== undefined ? CIRCLE_CLOSED_INVITE : CIRCLE_CLOSED_JOIN);
  }

  await transaction((client) => admitToCircle(client, circleId, userId));
}

/** S2 fix round 1: what someone an organiser removed from a circle is told when they try to join it again. */
export const REMOVED_FROM_CIRCLE = 'You were removed from this circle. Ask its owner or a moderator for an invitation.';

/** The invite an accept would let someone in with: who made it, for whom, and when (pod.service's shape). */
export type { ReturningInvite };

/** When this person was removed from the circle by its organisers, or null (never, or let back in since). */
async function circleRemovalOf(circleId: string, userId: string): Promise<Date | null> {
  const r = await query<{ created_at: Date }>(
    `SELECT created_at FROM circle_removals WHERE circle_id = $1 AND user_id = $2`, [circleId, userId]);
  return r.rows[0]?.created_at ?? null;
}

/** A personal invite (one address, one use), made after the removal, by someone who runs the circle now. */
async function organiserInvitedBack(
  circleId: string,
  removedAt: Date,
  opts: { invitedBy?: string; invite?: ReturningInvite },
): Promise<boolean> {
  const inv = opts.invite;
  if (!inv || opts.invitedBy === undefined) return false;
  if (!inv.inviteeEmail || inv.maxUses > 1) return false;
  if (new Date(inv.createdAt).getTime() <= new Date(removedAt).getTime()) return false;
  return inviterRunsCircle(circleId, opts.invitedBy);
}

/** Is this member in the circle? The gate for circle-level invites (C3). */
export async function isCircleMember(circleId: string, userId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}

/** S2: what an owner is told on pressing Leave. A circle is never left without its owner. */
export const OWNER_CANNOT_LEAVE = 'Hand the circle to someone else before you leave it.';

/**
 * Leave a circle. Its owner cannot (S2): they hand it to someone first, so a circle is never left without the person
 * who runs it. The owner's row is read under a lock in the same transaction as the delete, so a handover that lands at
 * the same moment is seen. Someone not in it leaves nothing (no error, as before).
 */
export async function leaveCircle(circleId: string, userId: string): Promise<void> {
  await transaction(async (client) => {
    // S2 fix round 1: lock the circle row FIRST, the order every circle write takes (role change, handover, removal),
    // so a Leave at the same moment as one of them waits its turn instead of deadlocking.
    const locked = await client.query(`SELECT id FROM circles WHERE id = $1 FOR UPDATE`, [circleId]);
    if (!locked.rows[0]) throw new NotFoundError('Circle', circleId);
    const mine = await client.query<{ role: string }>(
      `SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE`, [circleId, userId]);
    if (mine.rows[0]?.role === 'owner') throw new ValidationError(OWNER_CANNOT_LEAVE);
    const del = await client.query(
      `DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2`,
      [circleId, userId],
    );
    if (del.rowCount && del.rowCount > 0) {
      await client.query(
        `UPDATE circles SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`, [circleId]);
    }
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listCircles(userId: string, userRole?: string): Promise<CircleSummary[]> {
  const isAdmin = isPlatformAdmin(userRole);
  const r = await query<CircleAccessRow & {
    id: string; name: string; description: string | null;
    parent_circle_id: string | null; member_count: number;
    pod_count: string; created_at: Date;
  }>(
    `SELECT c.id, c.name, c.description, c.parent_circle_id, ${activeCircleMemberCount('c')} AS member_count, c.created_at,
            (SELECT count(*) FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id
              WHERE cp.circle_id = c.id AND ${visiblePodSql('p', '$1', '$2')})::text AS pod_count,
            ${circleAccessColumns('c', '$1', '$2')}
     FROM circles c
     WHERE c.archived_at IS NULL
     ORDER BY member_count DESC, c.created_at ASC`,
    [userId, isAdmin],
  );
  return r.rows.map(c => ({
    id: c.id, name: c.name, description: c.description,
    parentCircleId: c.parent_circle_id, memberCount: c.member_count,
    podCount: parseInt(c.pod_count, 10), isMember: c.is_member, createdAt: c.created_at,
    ...toCircleAccess(c),
  }));
}

/** Which circles is this pod attached to (pod page chips, P3b). */
export async function listCirclesOfPod(podId: string): Promise<Array<{ id: string; name: string }>> {
  const r = await query<{ id: string; name: string }>(
    `SELECT c.id, c.name
     FROM circle_pods cp JOIN circles c ON c.id = cp.circle_id
     WHERE cp.pod_id = $1 AND c.archived_at IS NULL
     ORDER BY c.name ASC`,
    [podId],
  );
  return r.rows;
}

export async function getCircleDetail(circleId: string, userId: string, userRole?: string): Promise<CircleDetail> {
  const isAdmin = isPlatformAdmin(userRole);
  const c = await query<CircleAccessRow & {
    id: string; name: string; description: string | null;
    parent_circle_id: string | null; member_count: number; created_at: Date;
    public_pod_count: number;
  }>(
    `SELECT c.id, c.name, c.description, c.parent_circle_id, ${activeCircleMemberCount('c')} AS member_count, c.created_at,
            (SELECT count(*)::int FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id
              WHERE cp.circle_id = c.id AND p.status <> 'archived' AND p.visibility::text NOT IN ${NOT_DISCOVERABLE}) AS public_pod_count,
            ${circleAccessColumns('c', '$2', '$3')}
     FROM circles c WHERE c.id = $1 AND c.archived_at IS NULL`,
    [circleId, userId, isAdmin],
  );
  const circle = c.rows[0];
  if (!circle) throw new NotFoundError('Circle', circleId);
  const access = toCircleAccess(circle);

  // Three indexed queries, no N+1: members (joined users), pods, events of
  // those pods. Members capped at 100 for the page; full list can paginate later.
  // T2 (1 Nov 2026): members are the active accounts only, and an attached pod's event is named only to someone who
  // may open it (D3: a private pod's event titles were shown to any signed-in member). Admins see every event.
  // T13 (1 Nov 2026): the events are the circle's own (sessions.circle_id) and its pods', each under the same rule.
  // T14: a locked circle (closed, the viewer outside it) is not asked for its members, pods or events at all; an
  // attached pod is named only when it is not archived and, if private, to its members.
  const seesEveryEvent = !!userRole && hasRoleAtLeast(userRole as UserRole, UserRole.ADMIN);
  const none = Promise.resolve({ rows: [] as never[] });
  const [members, pods, events, children, entities] = await Promise.all([
    access.locked ? none : query<{ user_id: string; display_name: string | null; avatar_url: string | null; role: string; joined_at: Date }>(
      `SELECT m.user_id, u.display_name, u.avatar_url, m.role, m.joined_at
       FROM circle_members m JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = $1 AND ${activeMemberSql('u')} ORDER BY m.joined_at ASC LIMIT 100`,
      [circleId],
    ),
    access.locked ? none : query<{ pod_id: string; name: string; description: string | null; visibility: string }>(
      `SELECT cp.pod_id, p.name, p.description, p.visibility::text AS visibility
       FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id
       WHERE cp.circle_id = $1 AND ${visiblePodSql('p', '$2', '$3')} ORDER BY cp.created_at ASC`,
      [circleId, userId, seesEveryEvent],
    ),
    access.locked ? none : query<{
      id: string; title: string; scheduled_at: Date; pod_id: string; for_circle: boolean;
      timezone: string | null; has_image: boolean | null; image_updated_at: Date | null;
    }>(
      `SELECT s.id, s.title, s.scheduled_at, s.pod_id, (s.circle_id IS NOT DISTINCT FROM $1::uuid) AS for_circle,
              s.timezone, ${eventImageColumns('s')}
       FROM sessions s
       WHERE (s.circle_id = $1 OR s.pod_id IN (SELECT pod_id FROM circle_pods WHERE circle_id = $1))
         AND s.status = 'scheduled' AND s.scheduled_at > NOW()
         AND ($3::boolean OR ${visibleEventsSql('s', '$2')})
       ORDER BY s.scheduled_at ASC LIMIT 10`,
      [circleId, userId, seesEveryEvent],
    ),
    query<{ id: string; name: string; member_count: number }>(
      `SELECT ch.id, ch.name, ${activeCircleMemberCount('ch')} AS member_count FROM circles ch
       WHERE ch.parent_circle_id = $1 AND ch.archived_at IS NULL
       ORDER BY member_count DESC`,
      [circleId],
    ),
    // T15: the entities linked to it. A locked circle names none, as it names no members (L22).
    access.locked ? Promise.resolve([] as CircleEntityLink[]) : entitiesOfCircle(circleId),
  ]);

  return {
    id: circle.id, name: circle.name, description: circle.description,
    parentCircleId: circle.parent_circle_id, memberCount: circle.member_count,
    isMember: circle.is_member, createdAt: circle.created_at,
    podCount: access.locked ? circle.public_pod_count : pods.rows.length,
    ...access,
    members: members.rows.map(m => ({
      userId: m.user_id, displayName: m.display_name, avatarUrl: m.avatar_url,
      role: m.role, joinedAt: m.joined_at,
    })),
    pods: pods.rows.map(p => ({ podId: p.pod_id, name: p.name, description: p.description, visibility: p.visibility === 'invite_only' ? 'private' : p.visibility })),
    upcomingEvents: events.rows.map(e => ({
      id: e.id, title: e.title, scheduledAt: e.scheduled_at, podId: e.pod_id, forCircle: !!e.for_circle,
      timezone: eventZone(e.timezone), imageUrl: eventImageUrlOf(e.id, e),
    })),
    children: children.rows.map(ch => ({ id: ch.id, name: ch.name, memberCount: ch.member_count })),
    entities,
  };
}
