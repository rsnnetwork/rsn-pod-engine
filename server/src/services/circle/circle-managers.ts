// ─── Who runs a circle (1 Nov 2026, L21; Shirley pilot S2, 11 Nov 2026, D3) ────────────────────────────────────
//
// A circle's managers are its owner and its moderators (circle_members.role), and platform admins. Every circle gate
// asks here, so the rule is written once. S2: authority comes from the role alone. The person who made a circle
// (circles.created_by) is only its history: a maker who hands the circle over, steps down or leaves holds no right for
// having made it (migration 148 gave every circle exactly one owner first). Managing does not require being in the
// circle only for platform admins, who run every circle.
//
// Owner and moderator differ (D3): moderators run the circle with the owner (members, asks, invitations, pods,
// events); only the owner (or a platform admin) makes and unmakes moderators, hands the circle to someone else and
// chooses who can join, and only they remove a moderator.

import { query } from '../../db';
import { AppError, NotFoundError } from '../../middleware/errors';
import { CircleAccess, CircleJoinPolicy, CircleMyStatus, CircleRole, ErrorCodes, UserRole } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';

export const isPlatformAdmin = (role: string | undefined) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

/** What someone who is not the owner is told when they try an owner's action. */
export const OWNER_ONLY = "Only the circle's owner can do that.";

/** Whether this person runs the circle: an owner or moderator, or a platform admin. */
export async function isCircleManager(circleId: string, userId: string, role: string | undefined): Promise<boolean> {
  if (isPlatformAdmin(role)) return true;
  const r = await query(
    `SELECT 1 FROM circle_members m
      WHERE m.circle_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'moderator')`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}

/** The person's role in the circle, or null when they are not in it. */
export async function circleRoleOf(circleId: string, userId: string): Promise<CircleRole | null> {
  const r = await query<{ role: CircleRole }>(
    `SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, userId]);
  return r.rows[0]?.role ?? null;
}

/**
 * Whether this person may invite to the circle (one rule for the single invite, the sheet's list and its batch).
 * An open circle: anyone in it, whatever their role there (the rule before managers existed, unchanged). A closed
 * circle (30 Oct review, 7.5): only the people who run it, since an invite lets its person straight in. One lookup
 * answers it.
 */
export async function mayInviteToCircle(circleId: string, userId: string, role: string | undefined): Promise<boolean> {
  if (isPlatformAdmin(role)) return true;
  const r = await query(
    `SELECT 1 FROM circles c
       JOIN circle_members m ON m.circle_id = c.id AND m.user_id = $2
      WHERE c.id = $1 AND (c.join_policy = 'open' OR m.role IN ('owner', 'moderator'))`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}

interface LiveCircle { id: string; name: string; joinPolicy: CircleJoinPolicy }

async function liveCircleOrNotFound(circleId: string): Promise<LiveCircle> {
  const r = await query<{ id: string; name: string; join_policy: CircleJoinPolicy }>(
    `SELECT id, name, join_policy FROM circles WHERE id = $1 AND archived_at IS NULL`,
    [circleId],
  );
  const circle = r.rows[0];
  if (!circle) throw new NotFoundError('Circle', circleId);
  return { id: circle.id, name: circle.name, joinPolicy: circle.join_policy };
}

/** Only the people who run a circle may do this. 404 for a missing or archived circle, 403 for anyone else. */
export async function assertCircleManager(
  circleId: string,
  userId: string,
  role: string | undefined,
  refusal = 'Only the people who run this circle can do that.',
): Promise<LiveCircle> {
  const circle = await liveCircleOrNotFound(circleId);
  if (!(await isCircleManager(circleId, userId, role))) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, refusal);
  return circle;
}

/** Only the circle's owner (or a platform admin) may do this. 404 for a missing or archived circle, 403 otherwise. */
export async function assertCircleOwner(
  circleId: string,
  userId: string,
  role: string | undefined,
  refusal = OWNER_ONLY,
): Promise<LiveCircle> {
  const circle = await liveCircleOrNotFound(circleId);
  if (isPlatformAdmin(role)) return circle;
  if ((await circleRoleOf(circleId, userId)) !== 'owner') throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, refusal);
  return circle;
}

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const PARAM = /^\$[1-9][0-9]?$/;

/**
 * The columns a circle read adds for the viewer, from the circle aliased `circle`: its policy, whether the viewer is
 * in it and their role there, whether they run it (`isAdminParam` is a boolean parameter: a platform admin runs every
 * circle), their latest ask, and its pending asks from active accounts. toCircleAccess turns them into the additive
 * fields. The pieces are fixed text checked here; nothing a member types reaches them.
 */
export function circleAccessColumns(circle: string, viewerParam: string, isAdminParam: string): string {
  if (!ALIAS.test(circle) || !PARAM.test(viewerParam) || !PARAM.test(isAdminParam)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Not a table alias or a parameter');
  }
  const c = circle;
  const me = viewerParam;
  return `${c}.join_policy,
    EXISTS (SELECT 1 FROM circle_members ax_m WHERE ax_m.circle_id = ${c}.id AND ax_m.user_id = ${me}) AS is_member,
    (SELECT ax_w.role FROM circle_members ax_w WHERE ax_w.circle_id = ${c}.id AND ax_w.user_id = ${me}) AS my_role,
    ${isAdminParam}::boolean AS viewer_is_admin,
    (${isAdminParam}::boolean
      OR EXISTS (SELECT 1 FROM circle_members ax_o WHERE ax_o.circle_id = ${c}.id AND ax_o.user_id = ${me}
                    AND ax_o.role IN ('owner', 'moderator'))) AS can_manage,
    (SELECT ax_r.status FROM circle_join_requests ax_r WHERE ax_r.circle_id = ${c}.id AND ax_r.user_id = ${me}
      ORDER BY ax_r.created_at DESC LIMIT 1) AS my_request,
    (SELECT count(*)::int FROM circle_join_requests ax_p JOIN users ax_u ON ax_u.id = ax_p.user_id
      WHERE ax_p.circle_id = ${c}.id AND ax_p.status = 'pending' AND ${activeMemberSql('ax_u')}) AS request_count`;
}

export interface CircleAccessRow {
  join_policy: CircleJoinPolicy | null;
  is_member: boolean;
  my_role?: CircleRole | null;
  viewer_is_admin?: boolean | null;
  can_manage: boolean;
  my_request: string | null;
  request_count: number | null;
}

const ROLES: readonly CircleRole[] = ['owner', 'moderator', 'member'];

/** What the viewer may do with a circle, from circleAccessColumns. requestCount only for the people who run it. */
export function toCircleAccess(row: CircleAccessRow): CircleAccess {
  const joinPolicy: CircleJoinPolicy = row.join_policy === 'closed' ? 'closed' : 'open';
  const isMember = !!row.is_member;
  const canManage = !!row.can_manage;
  const myRole: CircleRole | null = isMember && row.my_role && ROLES.includes(row.my_role) ? row.my_role : (isMember ? 'member' : null);
  let myStatus: CircleMyStatus = null;
  if (isMember) myStatus = 'member';
  else if (row.my_request === 'pending') myStatus = 'requested';
  else if (row.my_request === 'declined') myStatus = 'declined';
  const access: CircleAccess = {
    joinPolicy,
    myStatus,
    canManage,
    canInvite: canManage || (joinPolicy === 'open' && isMember),
    locked: joinPolicy === 'closed' && !isMember && !canManage,
    myRole,
    isOwner: myRole === 'owner' || !!row.viewer_is_admin,
  };
  if (canManage) access.requestCount = row.request_count ?? 0;
  return access;
}
