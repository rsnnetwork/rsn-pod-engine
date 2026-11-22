// ─── A pod inside a main pod whose pods are for its members (Stefan, 22 Nov 2026) ───────────────────────────────────
//
// "In a pod inside a pod, must people be in the parent pod first?" "No, dependent on choice of pod owner." The main
// pod's director turns on pods.inner_pods_members_only (migration 161); while it is on, nobody becomes an active or
// pending member of a pod inside it without being an active member of the main pod. This is the ONE rule, asked by every
// path that writes such a row, inside that path's own transaction:
//   * pod.service.ts addMember (a director or host adding someone, a self-join, an ask to join, an accepted pod or
//     event invite), and approveMember (an ask approved after the setting was turned on);
//   * session.service.ts registerParticipant (registering for an event of a public pod adds the person to the pod).
// Platform admins are exempt, as the person joining. Nothing here ever takes anyone out: switching the setting on, or
// leaving the main pod, leaves every membership of its pods as it is. An archived main pod keeps its director's choice.

import { ErrorCodes, isDiscoverablePod } from '@rsn/shared';
import { AppError } from '../../middleware/errors';

/** Whatever runs one SQL statement: the pool's `query` or a transaction's client. */
export interface Queryable {
  query: <R extends Record<string, unknown>>(sql: string, params: unknown[]) => Promise<{ rows: R[] }>;
}

/** The main pod keeping someone out of one of its pods. */
export interface MainPodKeepingOut { id: string; name: string; visibility: string }

/**
 * Who reads the refusal: the person joining by themselves (a join, an ask, an invite they accept), the person
 * registering for one of the pod's events, or the director or host who was adding or approving them.
 */
export type GateVoice = 'self' | 'event' | 'organiser';

/** The main pod of `podId` whose pods are for its members, when `userId` is not one of them (and not a platform admin). */
export async function mainPodKeepingOut(db: Queryable, podId: string, userId: string): Promise<MainPodKeepingOut | null> {
  const r = await db.query<{ id: string; name: string; visibility: string }>(
    `SELECT parent.id, parent.name, parent.visibility::text AS visibility
       FROM pods child
       JOIN pods parent ON parent.id = child.parent_pod_id
      WHERE child.id = $1
        AND parent.inner_pods_members_only
        AND NOT EXISTS (SELECT 1 FROM pod_members pm
                         WHERE pm.pod_id = parent.id AND pm.user_id = $2 AND pm.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM users a WHERE a.id = $2 AND a.role IN ('admin', 'super_admin'))`,
    [podId, userId],
  );
  return r.rows[0] ?? null;
}

/**
 * What the refusal says. A main pod people may find is named; a private one is not (they cannot see it, so its name
 * would leak): it is "the pod this one is part of".
 */
export function mainPodRefusal(main: Pick<MainPodKeepingOut, 'name' | 'visibility'>, voice: GateVoice = 'self'): string {
  const named = isDiscoverablePod(main.visibility);
  if (voice === 'organiser') {
    return named
      ? `This person is not a member of ${main.name}, and its pods are for its members. They join ${main.name} first.`
      : 'This person is not a member of the pod this one is part of, and its pods are for its members.';
  }
  if (voice === 'event') {
    return named
      ? `This event belongs to a pod inside ${main.name}. Join ${main.name} first. Its pods are for its members.`
      : "This event belongs to a pod for the members of the pod it is part of. Ask that pod's director for an invitation.";
  }
  return named
    ? `Join ${main.name} first. Its pods are for its members.`
    : "This pod is for the members of the pod it is part of. Ask that pod's director for an invitation.";
}

/**
 * Refuse (403 MAIN_POD_MEMBERS_ONLY) making `userId` a member of `podId` while its main pod keeps them out. A caller
 * that has just read (and locked) the pod's row passes its `parentPodId`: null means it stands alone, and nothing more
 * is read. Left out, the pod's main pod is read here.
 */
export async function assertMayJoinInnerPod(
  db: Queryable,
  podId: string,
  userId: string,
  voice: GateVoice = 'self',
  parentPodId?: string | null,
): Promise<void> {
  if (parentPodId === null) return;
  const main = await mainPodKeepingOut(db, podId, userId);
  if (!main) return;
  const details = isDiscoverablePod(main.visibility) ? { mainPod: { id: main.id, name: main.name } } : undefined;
  throw new AppError(403, ErrorCodes.MAIN_POD_MEMBERS_ONLY, mainPodRefusal(main, voice), details);
}
