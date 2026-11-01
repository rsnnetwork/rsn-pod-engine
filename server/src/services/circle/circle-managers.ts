// ─── Who runs a circle (1 Nov 2026, L21) ──────────────────────────────────────────────────────────────────────
//
// A circle's managers are the person who made it, its owner and moderators (circle_members.role), and platform
// admins. Every circle gate asks here, so the rule is written once. Managing does not require being a member of
// the circle: an admin who made no row for themselves still manages it, and so does a creator whose membership
// row is missing (circles made before the creator was added as owner; migration 118 backfills them).

import { query } from '../../db';
import { AppError, NotFoundError } from '../../middleware/errors';
import { CircleAccess, CircleJoinPolicy, CircleMyStatus, ErrorCodes, UserRole } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';

export const isPlatformAdmin = (role: string | undefined) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

/** Whether this person runs the circle: its creator, an owner or moderator, or a platform admin. */
export async function isCircleManager(circleId: string, userId: string, role: string | undefined): Promise<boolean> {
  if (isPlatformAdmin(role)) return true;
  const r = await query(
    `SELECT 1 FROM circles c
      WHERE c.id = $1
        AND (c.created_by = $2
             OR EXISTS (SELECT 1 FROM circle_members m
                         WHERE m.circle_id = c.id AND m.user_id = $2 AND m.role IN ('owner', 'moderator')))`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}

/**
 * Whether this person may invite to the circle (one rule for the single invite, the sheet's list and its batch).
 * An open circle: anyone in it, whatever their role there (the rule before managers existed, unchanged), and the
 * people who run it without being in it. A closed circle (30 Oct review, 7.5): only the people who run it, since
 * an invite lets its person straight in. One lookup answers it.
 */
export async function mayInviteToCircle(circleId: string, userId: string, role: string | undefined): Promise<boolean> {
  if (isPlatformAdmin(role)) return true;
  const r = await query(
    `SELECT 1 FROM circles c
      WHERE c.id = $1
        AND (c.created_by = $2
             OR EXISTS (SELECT 1 FROM circle_members m
                         WHERE m.circle_id = c.id AND m.user_id = $2
                           AND (c.join_policy = 'open' OR m.role IN ('owner', 'moderator'))))`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}

/** Only the people who run a circle may do this. 404 for a missing or archived circle, 403 for anyone else. */
export async function assertCircleManager(
  circleId: string,
  userId: string,
  role: string | undefined,
  refusal = 'Only the people who run this circle can do that.',
): Promise<{ id: string; name: string; joinPolicy: CircleJoinPolicy; createdBy: string }> {
  const r = await query<{ id: string; name: string; join_policy: CircleJoinPolicy; created_by: string }>(
    `SELECT id, name, join_policy, created_by FROM circles WHERE id = $1 AND archived_at IS NULL`,
    [circleId],
  );
  const circle = r.rows[0];
  if (!circle) throw new NotFoundError('Circle', circleId);
  if (!(await isCircleManager(circleId, userId, role))) throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, refusal);
  return { id: circle.id, name: circle.name, joinPolicy: circle.join_policy, createdBy: circle.created_by };
}

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const PARAM = /^\$[1-9][0-9]?$/;

/**
 * The columns a circle read adds for the viewer, from the circle aliased `circle`: its policy, whether the viewer is
 * in it, whether they run it (`isAdminParam` is a boolean parameter: a platform admin runs every circle), their
 * latest ask, and its pending asks from active accounts. toCircleAccess turns them into the additive fields.
 * The pieces are fixed text checked here; nothing a member types reaches them.
 */
export function circleAccessColumns(circle: string, viewerParam: string, isAdminParam: string): string {
  if (!ALIAS.test(circle) || !PARAM.test(viewerParam) || !PARAM.test(isAdminParam)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Not a table alias or a parameter');
  }
  const c = circle;
  const me = viewerParam;
  return `${c}.join_policy,
    EXISTS (SELECT 1 FROM circle_members ax_m WHERE ax_m.circle_id = ${c}.id AND ax_m.user_id = ${me}) AS is_member,
    (${isAdminParam}::boolean OR ${c}.created_by = ${me}
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
  can_manage: boolean;
  my_request: string | null;
  request_count: number | null;
}

/** What the viewer may do with a circle, from circleAccessColumns. requestCount only for the people who run it. */
export function toCircleAccess(row: CircleAccessRow): CircleAccess {
  const joinPolicy: CircleJoinPolicy = row.join_policy === 'closed' ? 'closed' : 'open';
  const isMember = !!row.is_member;
  const canManage = !!row.can_manage;
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
  };
  if (canManage) access.requestCount = row.request_count ?? 0;
  return access;
}
