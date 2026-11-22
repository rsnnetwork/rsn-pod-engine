// ─── A member's badge (Shradha, 21 Nov 2026) ─────────────────────────────────
//
// "We are onboarding people now to the platform, once it's done, can we update a premium badge to them?" An admin gives
// (or takes away) the badge on one member or on many at once. It is display only: users.profile_badge, never
// users.is_premium, which changes live-event matching. Each change is on record (audit_log), with what it was before.

import type { ProfileBadgeKind } from '@rsn/shared';
import { transaction } from '../../db';

/** The most members one call may change: the admin Users page's bulk bar sends a page at most. */
export const PROFILE_BADGE_BULK_MAX = 100;

export interface BadgeChange {
  userId: string;
  from: ProfileBadgeKind | null;
  to: ProfileBadgeKind | null;
}

export interface BadgeResult {
  /** The members whose badge changed. A member who already had this badge is not in it. */
  changed: BadgeChange[];
  /** The ids that are no member at all. */
  missing: string[];
  /** How many of the (distinct) ids named a member. */
  found: number;
}

/**
 * Gives every member named `badge` (null removes it), in one transaction, and records each change in audit_log with
 * who made it. Members who already hold that badge are left alone and not recorded, so a second press changes nothing.
 */
export async function setProfileBadge(
  actorId: string,
  userIds: string[],
  badge: ProfileBadgeKind | null,
  ipAddress?: string,
): Promise<BadgeResult> {
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))];
  return transaction(async (client) => {
    const before = await client.query<{ id: string; profile_badge: ProfileBadgeKind | null }>(
      `SELECT id, profile_badge FROM users WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [ids],
    );
    const found = new Map(before.rows.map((r) => [r.id, r.profile_badge]));
    const changed: BadgeChange[] = before.rows
      .filter((r) => r.profile_badge !== badge)
      .map((r) => ({ userId: r.id, from: r.profile_badge, to: badge }));
    if (changed.length > 0) {
      const changedIds = changed.map((c) => c.userId);
      await client.query(
        `UPDATE users SET profile_badge = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
        [badge, changedIds],
      );
      // One row per member, written in the same transaction as the change, so the record and the badge cannot part.
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address)
         SELECT $1::uuid, 'user.profile_badge_changed', 'user', c.id, c.details, $3::inet
           FROM jsonb_to_recordset($2::jsonb) AS c(id uuid, details jsonb)`,
        [
          actorId,
          JSON.stringify(changed.map((c) => ({
            id: c.userId,
            details: { from: c.from, to: c.to, bulk: ids.length > 1 },
          }))),
          ipAddress ?? null,
        ],
      );
    }
    return { changed, missing: ids.filter((id) => !found.has(id)), found: found.size };
  });
}
