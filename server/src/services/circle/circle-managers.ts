// ─── Who runs a circle (1 Nov 2026, L21) ──────────────────────────────────────────────────────────────────────
//
// A circle's managers are the person who made it, its owner and moderators (circle_members.role), and platform
// admins. Every circle gate asks here, so the rule is written once. Managing does not require being a member of
// the circle: an admin who made no row for themselves still manages it, and so does a creator whose membership
// row is missing (circles made before the creator was added as owner; migration 118 backfills them).

import { query } from '../../db';
import { UserRole } from '@rsn/shared';

const isPlatformAdmin = (role: string | undefined) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

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
 * Whether this person may invite to the circle: anyone in it, whatever their role there (the rule before managers
 * existed, unchanged), and the people who run it without being in it. One lookup answers both.
 */
export async function mayInviteToCircle(circleId: string, userId: string, role: string | undefined): Promise<boolean> {
  if (isPlatformAdmin(role)) return true;
  const r = await query(
    `SELECT 1 FROM circles c
      WHERE c.id = $1
        AND (c.created_by = $2
             OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $2))`,
    [circleId, userId],
  );
  return r.rows.length > 0;
}
