// ─── A pod inside a closed or invite-only circle (Ben field test, 13 Nov 2026) ─────────────────────────────────────
//
// "Private Circles must enforce their restrictions." A pod belongs to circles through circle_pods. Before this gate,
// a pod's own visibility was the only thing that decided who could join it, so an open pod in a closed circle was a
// side door: anyone could join the pod and, as a member of its pod, see and register for the circle's events
// (event-access.ts exempts the event's pod members). Now joining a pod by yourself, or asking to, needs you to be in
// every closed or invite-only circle the pod belongs to. Invitations to the pod still work: an invite is a decision
// by the people who run the pod, not a door anyone can walk through. Platform admins are exempt (pod.service.ts lets
// them join any open pod before this is asked).

import { query } from '../../db';
import { ForbiddenError } from '../../middleware/errors';
import { readJoinPolicy } from '../circle/circle-managers';

interface OutsideCircle { name: string; join_policy: string }

/** The first closed or invite-only circle the pod belongs to that this person is not in, or null when there is none. */
export async function restrictedCircleOutside(podId: string, userId: string): Promise<OutsideCircle | null> {
  const r = await query<OutsideCircle>(
    `SELECT c.name, c.join_policy
       FROM circle_pods cp
       JOIN circles c ON c.id = cp.circle_id
      WHERE cp.pod_id = $1 AND c.archived_at IS NULL AND c.join_policy <> 'open'
        AND NOT EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $2)
      ORDER BY lower(c.name), c.id
      LIMIT 1`,
    [podId, userId],
  );
  return r.rows[0] ?? null;
}

/** What someone outside the pod's circle is told, in the circle's own terms. */
export function outsideCircleRefusal(circle: OutsideCircle): string {
  return readJoinPolicy(circle.join_policy) === 'invite_only'
    ? `This pod is part of ${circle.name}, which is by invitation only. Its owner or a moderator can invite you.`
    : `This pod is part of ${circle.name}. Ask to join ${circle.name} first.`;
}

/** Refuse a self-join or an ask to join a pod from someone outside one of its closed or invite-only circles. */
export async function assertInPodsRestrictedCircles(podId: string, userId: string): Promise<void> {
  const outside = await restrictedCircleOutside(podId, userId);
  if (outside) throw new ForbiddenError(outsideCircleRefusal(outside));
}
