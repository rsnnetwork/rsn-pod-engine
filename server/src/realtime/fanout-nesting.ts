// ─── Pods inside pods: who is told (22 Nov 2026) ────────────────────────────────────────────────────────────────────
//
// A main pod's page lists the pods inside it (`pod:<mainId>:inner-pods`); an inner pod's page says "Part of <main
// pod>" (`pod:<innerId>`); each member's pods list says "in <main pod>" on an inner pod (`user:<id>:pods`). So:
//   * fanoutNestingChange(ids): a pod was made inside, put inside or taken out, or the main pod's members-only choice
//     changed. Each named pod's people get the pod, its pods inside, and their own pods list.
//   * fanoutPodRelatives(id): the pod itself changed (renamed, archived, reactivated, someone joined or left): its main
//     pod's people get the main pod's pods inside (its name and member count are listed there), and each pod inside it
//     gets its own tag (the "Part of" line names it). readPodRelatives + tellPodRelatives split this for a hard delete,
//     whose rows are gone before anyone is told.
// Each runs after the change is saved and never throws. Without a socket server nothing is read.

import logger from '../config/logger';
import { getRealtimeIo } from './emit';
import { E } from './entities';
import { podAudience, tellPodAudience } from './fanout';

export interface PodRelatives { parentId: string | null; innerIds: string[] }

export async function fanoutNestingChange(podIds: Array<string | null | undefined>): Promise<void> {
  if (!getRealtimeIo()) return;
  const ids = [...new Set(podIds.filter((id): id is string => !!id))];
  for (const id of ids) {
    try {
      await tellPodAudience(await podAudience(id), id, [E.podInnerPods(id)], { includeUserPodsPerMember: true });
    } catch (err) {
      logger.warn({ err, podId: id }, 'fanoutNestingChange: failed to fan out');
    }
  }
}

/** The main pod a pod is inside, and the pods inside it (read before a hard delete takes the rows). */
export async function readPodRelatives(podId: string): Promise<PodRelatives> {
  const { query } = await import('../db');
  const r = await query<{ parent_pod_id: string | null; inner_ids: string[] | null }>(
    `SELECT p.parent_pod_id,
            ARRAY(SELECT c.id FROM pods c WHERE c.parent_pod_id = p.id ORDER BY c.id LIMIT 500) AS inner_ids
       FROM pods p WHERE p.id = $1`,
    [podId],
  );
  const row = r.rows[0];
  return { parentId: row?.parent_pod_id ?? null, innerIds: row?.inner_ids ?? [] };
}

export async function tellPodRelatives(relatives: PodRelatives): Promise<void> {
  if (!getRealtimeIo()) return;
  try {
    if (relatives.parentId) {
      await tellPodAudience(await podAudience(relatives.parentId), relatives.parentId, [E.podInnerPods(relatives.parentId)]);
    }
    for (const id of relatives.innerIds) {
      await tellPodAudience(await podAudience(id), id, [], { includeUserPodsPerMember: true });
    }
  } catch (err) {
    logger.warn({ err, relatives }, 'tellPodRelatives: failed to fan out');
  }
}

export async function fanoutPodRelatives(podId: string): Promise<void> {
  if (!getRealtimeIo()) return;
  try {
    const relatives = await readPodRelatives(podId);
    if (!relatives.parentId && relatives.innerIds.length === 0) return;
    await tellPodRelatives(relatives);
  } catch (err) {
    logger.warn({ err, podId }, 'fanoutPodRelatives: failed to fan out');
  }
}
