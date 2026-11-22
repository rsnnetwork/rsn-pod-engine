// ─── Pods inside pods: the rules (Stefan, 22 Nov 2026) ──────────────────────────────────────────────────────────────
//
// Circle (RSN admins) > main pod > the pods inside it > events. Stefan will confirm the defaults later, so each rule
// is one line of nestingRefusal and one constant here:
//   * ONE_LEVEL_ONLY: a main pod holds pods; a pod inside a main pod holds none, and a pod that holds pods cannot go
//     inside another. (Turning it off would also need a check that the child is not an ancestor of the parent: with
//     one level a cycle cannot happen, since a parent has no parent and a child has no children.)
//   * a pod is never inside itself (also a CHECK in migration 161);
//   * a pod already inside one main pod is taken out of it before it goes inside another;
//   * an archived pod neither takes pods nor goes inside one.
// A main pod may stand outside any circle, as pods always could. Nothing here imports pod.service.ts, which uses
// lockParentForNewInnerPod inside createPod's transaction.

import { ErrorCodes } from '@rsn/shared';
import { ConflictError, NotFoundError } from '../../middleware/errors';
import type { Queryable } from '../pods/pod-parent-gate';

/** One level of pods inside pods. */
export const ONE_LEVEL_ONLY = true;

/** What a member is told when a pod cannot go (or be made) where they asked. */
export const NESTING_REFUSAL = {
  self: 'A pod cannot be put inside itself.',
  parentIsInner: (parent: string) => `${parent} is inside another pod, so it cannot hold pods of its own.`,
  childHoldsPods: (child: string) => `${child} holds pods of its own, so it cannot go inside another pod.`,
  childInOther: (child: string) => `${child} is inside another pod already. Take it out of that pod first.`,
  archived: (name: string) => `${name} is archived. Reactivate it first.`,
  settingOnInner: 'This pod is inside another pod, so it holds no pods and this setting is not for it.',
} as const;

/** What the rules read about a pod, under its row lock. */
export interface NestingFacts {
  id: string;
  name: string;
  status: string;
  parentPodId: string | null;
  /** Pods inside it now, in any status. */
  innerPodCount: number;
}

/** Whether a pod may hold pods: under ONE_LEVEL_ONLY, a pod that is not inside another. */
export function mayHoldPods(pod: Pick<NestingFacts, 'parentPodId'>): boolean {
  return !ONE_LEVEL_ONLY || !pod.parentPodId;
}

/**
 * Why `child` may not go inside `parent` (or, with no child, why no new pod may be made inside `parent`), or null.
 * A child already inside this same parent is not refused: the caller answers that as nothing to change.
 */
export function nestingRefusal(parent: NestingFacts, child: NestingFacts | null): string | null {
  if (child && child.id === parent.id) return NESTING_REFUSAL.self;
  if (parent.status === 'archived') return NESTING_REFUSAL.archived(parent.name);
  if (!mayHoldPods(parent)) return NESTING_REFUSAL.parentIsInner(parent.name);
  if (!child) return null;
  if (child.status === 'archived') return NESTING_REFUSAL.archived(child.name);
  if (child.parentPodId && child.parentPodId !== parent.id) return NESTING_REFUSAL.childInOther(child.name);
  if (ONE_LEVEL_ONLY && child.innerPodCount > 0) return NESTING_REFUSAL.childHoldsPods(child.name);
  return null;
}

export const nestingRefused = (message: string) => new ConflictError(ErrorCodes.POD_NESTING_REFUSED, message);

/**
 * Lock these pods' rows (in id order, so two requests on the same pair never wait on each other) and read what the
 * rules need. Every write of pods.parent_pod_id locks the parent's row first (and the child's, when it moves an existing
 * pod), so the counts read here hold until the transaction ends. A missing pod is a 404.
 */
export async function lockNestingFacts(db: Queryable, podIds: string[]): Promise<Map<string, NestingFacts>> {
  const ids = [...new Set(podIds)].sort();
  const locked = await db.query<{ id: string; name: string; status: string; parent_pod_id: string | null }>(
    `SELECT id, name, status, parent_pod_id FROM pods WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  const counts = await db.query<{ parent_pod_id: string; cnt: number }>(
    `SELECT parent_pod_id, COUNT(*)::int AS cnt FROM pods WHERE parent_pod_id = ANY($1::uuid[]) GROUP BY parent_pod_id`,
    [ids],
  );
  const inner = new Map(counts.rows.map((r) => [r.parent_pod_id, Number(r.cnt)]));
  const facts = new Map<string, NestingFacts>();
  for (const r of locked.rows) {
    facts.set(r.id, { id: r.id, name: r.name, status: r.status, parentPodId: r.parent_pod_id, innerPodCount: inner.get(r.id) ?? 0 });
  }
  for (const id of ids) if (!facts.has(id)) throw new NotFoundError('Pod', id);
  return facts;
}

/** Inside createPod's transaction: lock the main pod a new pod is made in, and refuse when it may not hold one. */
export async function lockParentForNewInnerPod(db: Queryable, parentPodId: string): Promise<NestingFacts> {
  const parent = (await lockNestingFacts(db, [parentPodId])).get(parentPodId)!;
  const refusal = nestingRefusal(parent, null);
  if (refusal) throw nestingRefused(refusal);
  return parent;
}
