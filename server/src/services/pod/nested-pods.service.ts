// ─── Pods inside pods (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────────────────────────────
//
// "An event is in a pod", "a pod can be a main pod, like a circle", and whether people must be in the main pod first is
// "dependent on choice of pod owner". Circle (RSN admins) > main pod > the pods inside it > events.
//
// Who may do what:
//   * make a new pod inside a pod: its active director, or a platform admin (POST /pods with parentPodId; the new pod
//     and its link are one transaction in createPod, under a lock on the main pod's row);
//   * put an existing pod inside: someone who directs both, or a platform admin;
//   * take a pod out (it stands alone again; nothing else changes): the director of either pod, or a platform admin;
//   * choose "people must be members of <main pod> to join its pods": the main pod's director, or a platform admin.
// The rules on where a pod may go are nested-pods-rules.ts; the join rule is pods/pod-parent-gate.ts. Every read here
// shows a pod only to someone who may see it, as the pods list does: a pod people may find (when it is active), one the
// viewer is an active member of (any status), or any pod for a platform admin.

import {
  hasRoleAtLeast, isDiscoverablePod, UserRole, type InnerPodCandidate, type InnerPodItem, type PodNesting,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';
import { canViewPod } from '../pods/pod-access';
import { mainPodKeepingOut } from '../pods/pod-parent-gate';
import { activeMemberSql } from '../users/active-member';
import { lockNestingFacts, mayHoldPods, nestingRefusal, nestingRefused, NESTING_REFUSAL } from './nested-pods-rules';

export interface Viewer { userId: string; role: UserRole | string }

const isPlatformAdmin = (viewer: Viewer) => hasRoleAtLeast(viewer.role as UserRole, UserRole.ADMIN);

/** What each refusal of who may do it says. */
export const NESTING_PERMISSION = {
  make: "Only this pod's director can make a pod inside it.",
  put: 'You can put a pod inside another only when you direct both.',
  takeOut: 'Only the director of this pod, or of the pod it is in, can take it out.',
  setting: "Only this pod's director can choose who may join the pods inside it.",
} as const;

/** The most pods one main pod lists, and the most of the viewer's own pods offered to put inside. */
export const INNER_PODS_LIST_MAX = 200;

/** The viewer's active role in each of these pods. */
async function activeRoles(podIds: string[], userId: string): Promise<Map<string, string>> {
  const r = await query<{ pod_id: string; role: string }>(
    `SELECT pod_id, role FROM pod_members WHERE pod_id = ANY($1::uuid[]) AND user_id = $2 AND status = 'active'`,
    [podIds, userId],
  );
  return new Map(r.rows.map((row) => [row.pod_id, row.role]));
}

/** The viewer may see this pod (404 otherwise, as the pod itself), and directs it or is a platform admin (403). */
export async function assertDirectsPod(podId: string, viewer: Viewer, refusal: string): Promise<void> {
  if (!(await canViewPod(viewer.userId, podId, String(viewer.role)))) throw new NotFoundError('Pod', podId);
  if (isPlatformAdmin(viewer)) {
    const exists = await query(`SELECT 1 FROM pods WHERE id = $1`, [podId]);
    if (exists.rows.length === 0) throw new NotFoundError('Pod', podId);
    return;
  }
  if ((await activeRoles([podId], viewer.userId)).get(podId) !== 'director') throw new ForbiddenError(refusal);
}

/** The SQL that says the viewer ($2) may see pod `p` in a list, as the pods list does ($3: a platform admin). */
const LISTED_FOR_VIEWER = `($3::boolean
       OR EXISTS (SELECT 1 FROM pod_members seen WHERE seen.pod_id = p.id AND seen.user_id = $2 AND seen.status = 'active')
       OR (p.visibility::text IN ('public', 'public_with_approval') AND p.status = 'active'))`;

/** Where this pod sits, as its page shows it to the viewer (GET /pods/:id carries these beside the pod). */
export async function readPodNesting(pod: { id: string; parentPodId: string | null }, viewer: Viewer): Promise<PodNesting> {
  const admin = isPlatformAdmin(viewer);
  let parentPod: PodNesting['parentPod'] = null;
  let parentPodHidden = false;
  let joinNeedsMainPod = false;
  if (pod.parentPodId) {
    const parent = await query<{ id: string; name: string; visibility: string; member: boolean }>(
      `SELECT p.id, p.name, p.visibility::text AS visibility,
              EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active') AS member
         FROM pods p WHERE p.id = $1`,
      [pod.parentPodId, viewer.userId],
    );
    const row = parent.rows[0];
    if (row && (admin || row.member || isDiscoverablePod(row.visibility))) parentPod = { id: row.id, name: row.name };
    else if (row) parentPodHidden = true;
    joinNeedsMainPod = !!(await mainPodKeepingOut({ query }, pod.id, viewer.userId));
  }
  const counted = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM pods p WHERE p.parent_pod_id = $1 AND ${LISTED_FOR_VIEWER}`,
    [pod.id, viewer.userId, admin],
  );
  return {
    parentPod,
    parentPodHidden,
    innerPodCount: Number(counted.rows[0]?.cnt ?? 0),
    joinNeedsMainPod,
    mayHoldPods: mayHoldPods(pod),
  };
}

/** The pods inside this main pod that the viewer may see, by name. The main pod's own access is the route's check. */
export async function listInnerPods(mainPodId: string, viewer: Viewer): Promise<InnerPodItem[]> {
  const admin = isPlatformAdmin(viewer);
  const r = await query<Omit<InnerPodItem, 'mayTakeOut'> & { directsIt: boolean; directsMain: boolean }>(
    `SELECT p.id, p.name, p.description,
            CASE WHEN p.visibility::text = 'invite_only' THEN 'private' ELSE p.visibility::text END AS visibility,
            p.status,
            (SELECT COUNT(*) FROM pod_members pm JOIN users u ON u.id = pm.user_id
              WHERE pm.pod_id = p.id AND pm.status = 'active' AND ${activeMemberSql('u')})::int AS "memberCount",
            (SELECT COUNT(*) FROM sessions s WHERE s.pod_id = p.id AND s.publication = 'published')::int AS "sessionCount",
            me.role AS "memberRole",
            (me.role = 'director') AS "directsIt",
            EXISTS (SELECT 1 FROM pod_members md WHERE md.pod_id = $1 AND md.user_id = $2 AND md.status = 'active'
                       AND md.role = 'director') AS "directsMain"
       FROM pods p
       LEFT JOIN pod_members me ON me.pod_id = p.id AND me.user_id = $2 AND me.status = 'active'
      WHERE p.parent_pod_id = $1 AND ${LISTED_FOR_VIEWER}
      ORDER BY lower(p.name), p.id
      LIMIT ${INNER_PODS_LIST_MAX}`,
    [mainPodId, viewer.userId, admin],
  );
  return r.rows.map(({ directsIt, directsMain, ...item }) => ({
    ...item,
    memberRole: item.memberRole ?? null,
    mayTakeOut: admin || !!directsIt || !!directsMain,
  }));
}

/**
 * The viewer's own pods that could go inside this main pod: ones they direct that are not archived, not this pod, not
 * inside any pod and holding none (the rules in nested-pods-rules.ts, read here so the list offers only what would
 * be taken). Empty when this pod may not hold pods.
 */
export async function listInnerPodCandidates(mainPodId: string, viewer: Viewer): Promise<InnerPodCandidate[]> {
  const main = await query<{ parent_pod_id: string | null; status: string }>(
    `SELECT parent_pod_id, status FROM pods WHERE id = $1`, [mainPodId],
  );
  const row = main.rows[0];
  if (!row) throw new NotFoundError('Pod', mainPodId);
  if (!mayHoldPods({ parentPodId: row.parent_pod_id }) || row.status === 'archived') return [];
  const r = await query<InnerPodCandidate>(
    `SELECT p.id, p.name,
            (SELECT COUNT(*) FROM pod_members pm JOIN users u ON u.id = pm.user_id
              WHERE pm.pod_id = p.id AND pm.status = 'active' AND ${activeMemberSql('u')})::int AS "memberCount"
       FROM pods p
       JOIN pod_members me ON me.pod_id = p.id AND me.user_id = $2 AND me.status = 'active' AND me.role = 'director'
      WHERE p.id <> $1 AND p.parent_pod_id IS NULL AND p.status <> 'archived'
        AND NOT EXISTS (SELECT 1 FROM pods c WHERE c.parent_pod_id = p.id)
      ORDER BY lower(p.name), p.id
      LIMIT ${INNER_PODS_LIST_MAX}`,
    [mainPodId, viewer.userId],
  );
  return r.rows;
}

/** What a change of where a pod sits did: whether anything changed, and the main pod it left (for who is told). */
export interface NestingMove { changed: boolean; parentPodId: string | null; previousParentPodId: string | null }

/** Put an existing pod inside a main pod: someone who directs both, or a platform admin. */
export async function putPodInside(mainPodId: string, podId: string, viewer: Viewer): Promise<NestingMove> {
  if (mainPodId === podId) throw nestingRefused(NESTING_REFUSAL.self);
  // Neither pod is named to someone who may not see it (404, as each pod's own page).
  for (const id of [mainPodId, podId]) {
    if (!(await canViewPod(viewer.userId, id, String(viewer.role)))) throw new NotFoundError('Pod', id);
  }
  if (!isPlatformAdmin(viewer)) {
    const roles = await activeRoles([mainPodId, podId], viewer.userId);
    if (roles.get(mainPodId) !== 'director' || roles.get(podId) !== 'director') throw new ForbiddenError(NESTING_PERMISSION.put);
  }
  const move = await transaction(async (client) => {
    const facts = await lockNestingFacts(client, [mainPodId, podId]);
    const parent = facts.get(mainPodId)!;
    const child = facts.get(podId)!;
    if (child.parentPodId === mainPodId) return { changed: false, parentPodId: mainPodId, previousParentPodId: mainPodId };
    const refusal = nestingRefusal(parent, child);
    if (refusal) throw nestingRefused(refusal);
    await client.query(`UPDATE pods SET parent_pod_id = $1, updated_at = NOW() WHERE id = $2`, [mainPodId, podId]);
    return { changed: true, parentPodId: mainPodId, previousParentPodId: null };
  });
  if (move.changed) logger.info({ mainPodId, podId, userId: viewer.userId }, 'Pod put inside a main pod');
  return move;
}

/** Take a pod out of the main pod it is in: it stands alone again. The director of either pod, or a platform admin. */
export async function takePodOut(podId: string, viewer: Viewer): Promise<NestingMove> {
  if (!(await canViewPod(viewer.userId, podId, String(viewer.role)))) throw new NotFoundError('Pod', podId);
  const admin = isPlatformAdmin(viewer);
  const move = await transaction(async (client) => {
    const child = (await lockNestingFacts(client, [podId])).get(podId)!;
    if (!child.parentPodId) return { changed: false, parentPodId: null, previousParentPodId: null };
    if (!admin) {
      const r = await client.query<{ pod_id: string }>(
        `SELECT pod_id FROM pod_members
          WHERE pod_id = ANY($1::uuid[]) AND user_id = $2 AND status = 'active' AND role = 'director'`,
        [[podId, child.parentPodId], viewer.userId],
      );
      if (r.rows.length === 0) throw new ForbiddenError(NESTING_PERMISSION.takeOut);
    }
    await client.query(`UPDATE pods SET parent_pod_id = NULL, updated_at = NOW() WHERE id = $1`, [podId]);
    return { changed: true, parentPodId: null, previousParentPodId: child.parentPodId };
  });
  if (move.changed) logger.info({ podId, mainPodId: move.previousParentPodId, userId: viewer.userId }, 'Pod taken out of its main pod');
  return move;
}

/** The main pod's director chooses whether people must be its members to join the pods inside it. */
export async function setInnerPodsMembersOnly(
  mainPodId: string,
  membersOnly: boolean,
  viewer: Viewer,
): Promise<{ innerPodsMembersOnly: boolean; changed: boolean }> {
  await assertDirectsPod(mainPodId, viewer, NESTING_PERMISSION.setting);
  const result = await transaction(async (client) => {
    const main = (await lockNestingFacts(client, [mainPodId])).get(mainPodId)!;
    if (!mayHoldPods(main)) throw nestingRefused(NESTING_REFUSAL.settingOnInner);
    const before = await client.query<{ members_only: boolean }>(
      `SELECT inner_pods_members_only AS members_only FROM pods WHERE id = $1`,
      [mainPodId],
    );
    if (before.rows[0]?.members_only === membersOnly) return { innerPodsMembersOnly: membersOnly, changed: false };
    await client.query(
      `UPDATE pods SET inner_pods_members_only = $2, updated_at = NOW() WHERE id = $1`,
      [mainPodId, membersOnly],
    );
    return { innerPodsMembersOnly: membersOnly, changed: true };
  });
  if (result.changed) logger.info({ mainPodId, membersOnly, userId: viewer.userId }, 'Main pod members-only choice set');
  return result;
}
