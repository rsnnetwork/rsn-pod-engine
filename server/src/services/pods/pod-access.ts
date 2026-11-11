// ─── Pod Access Control ──────────────────────────────────────────────────────
// Read-access gate for pod detail endpoints. Private pods are hidden from
// non-members — callers should treat a `false` result as 404 (don't leak
// existence, mirroring GitHub private-repo UX).

import { isDiscoverablePod } from '@rsn/shared';
import { query } from '../../db';

/**
 * Determines if a user can view a pod's details (its overview, events count, rules and the circles it is in).
 *
 * Rules (short-circuit in order):
 *   1. Admin / super_admin → allowed
 *   2. Pod doesn't exist → denied
 *   3. Pod is public or public_with_approval → allowed (the overview is discoverable)
 *   4. Otherwise (private, or an old invite_only row, which reads as private: Shirley pilot S2, D2) → only an ACTIVE
 *      member. S2 (11 Nov 2026): any pod_members row used to count, so someone removed from a private pod, or who left
 *      it, or whose ask was turned down, still opened its overview. Now they get the same 404 as anyone outside it.
 *      An invitation that was not yet accepted is not membership either: the invite's own page names the pod.
 */
export async function canViewPod(
  userId: string,
  podId: string,
  userRole: string,
): Promise<boolean> {
  if (userRole === 'admin' || userRole === 'super_admin') return true;

  const r = await query<{ visibility: string; active_member: boolean }>(
    `SELECT p.visibility::text AS visibility,
            EXISTS (SELECT 1 FROM pod_members pm
                     WHERE pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active') AS active_member
       FROM pods p WHERE p.id = $1`,
    [podId, userId],
  );
  const pod = r.rows[0];
  if (!pod) return false;
  if (isDiscoverablePod(pod.visibility)) return true;
  return !!pod.active_member;
}
