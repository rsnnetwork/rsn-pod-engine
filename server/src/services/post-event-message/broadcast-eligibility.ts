import { UserRole, hasRoleAtLeast, type BroadcastEligibility } from '@rsn/shared';
import { query } from '../../db';

export interface EligibilityInputs {
  role: UserRole;
  isPro: boolean;
  isDirector: boolean;
}

/** Pure policy. v1: only admins are enabled; pro/director see coming-soon. */
export function computeEligibility(i: EligibilityInputs): BroadcastEligibility {
  if (hasRoleAtLeast(i.role, UserRole.ADMIN)) {
    return { enabled: true, visible: true, reason: 'admin' };
  }
  if (i.isPro) return { enabled: false, visible: true, reason: 'pro_coming_soon' };
  if (i.isDirector) return { enabled: false, visible: true, reason: 'director_coming_soon' };
  return { enabled: false, visible: false, reason: 'not_allowed' };
}

/** Resolve the inputs for a user against the event's pod, then apply policy. */
export async function getEligibilityForEvent(
  userId: string,
  userRole: UserRole,
  sessionId: string,
): Promise<BroadcastEligibility> {
  const sub = await query<{ plan: string }>(
    `SELECT plan FROM user_subscriptions WHERE user_id = $1`, [userId],
  );
  const isPro = sub.rows[0]?.plan === 'premium';

  const dir = await query<{ role: string }>(
    `SELECT pm.role FROM pod_members pm
     JOIN sessions s ON s.pod_id = pm.pod_id
     WHERE s.id = $1 AND pm.user_id = $2 AND pm.role = 'director' AND pm.status = 'active'
     LIMIT 1`,
    [sessionId, userId],
  );
  const isDirector = dir.rows.length > 0;

  return computeEligibility({ role: userRole, isPro, isDirector });
}
