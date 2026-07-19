// ─── Circle Service ──────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). A circle is a COMMUNITY (people with the
// same intent/type — Stefan's definition); pods are ACTIVITY containers
// attached to circles many-to-many. Admin-created v1; open join (flagged
// default); membership gates nothing except (later) wall posting.
//
// Architecture: docs/superpowers/plans/2026-07-19-circles-wall-architecture.md
// Rules enforced here rather than in SQL: nesting cycle rejection + depth cap
// (Postgres can't CHECK graph properties; writes are admin-only so this is
// contention-free).

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

export const MAX_NESTING_DEPTH = 3;

export interface CircleSummary {
  id: string;
  name: string;
  description: string | null;
  parentCircleId: string | null;
  memberCount: number;
  podCount: number;
  isMember: boolean;
  createdAt: Date;
}

export interface CircleDetail extends Omit<CircleSummary, 'podCount'> {
  members: Array<{
    userId: string; displayName: string | null; avatarUrl: string | null;
    role: string; joinedAt: Date;
  }>;
  pods: Array<{ podId: string; name: string; description: string | null }>;
  upcomingEvents: Array<{ id: string; title: string; scheduledAt: Date; podId: string }>;
  children: Array<{ id: string; name: string; memberCount: number }>;
}

// ── Nesting integrity ────────────────────────────────────────────────────────

/**
 * Walk ancestors of `parentId`; reject if `circleId` appears (cycle) or the
 * chain exceeds MAX_NESTING_DEPTH. Admin-only writes → no lock contention.
 */
async function assertValidParent(parentId: string, circleId: string | null): Promise<void> {
  let cursor: string | null = parentId;
  let depth = 1;
  while (cursor) {
    if (circleId !== null && cursor === circleId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'A circle cannot contain itself');
    }
    if (depth > MAX_NESTING_DEPTH) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Circles can nest at most ${MAX_NESTING_DEPTH} levels deep`);
    }
    const r: { rows: Array<{ parent_circle_id: string | null }> } = await query(
      `SELECT parent_circle_id FROM circles WHERE id = $1 AND archived_at IS NULL`,
      [cursor],
    );
    if (r.rows.length === 0) throw new NotFoundError('Circle', cursor);
    cursor = r.rows[0].parent_circle_id;
    depth++;
  }
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────

export async function createCircle(
  adminUserId: string,
  input: { name: string; description?: string | null; parentCircleId?: string | null },
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Circle name must be at least 2 characters');
  }
  if (input.parentCircleId) await assertValidParent(input.parentCircleId, null);

  try {
    const r = await query<{ id: string }>(
      `INSERT INTO circles (name, description, parent_circle_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, input.description?.trim() || null, input.parentCircleId ?? null, adminUserId],
    );
    logger.info({ circleId: r.rows[0].id, name, adminUserId }, 'Circle created');
    return r.rows[0];
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A circle with that name already exists here');
    }
    throw err;
  }
}

export async function updateCircle(
  circleId: string,
  input: { name?: string; description?: string | null; parentCircleId?: string | null },
): Promise<void> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (existing.rows.length === 0) throw new NotFoundError('Circle', circleId);

  if (input.parentCircleId) await assertValidParent(input.parentCircleId, circleId);

  const sets: string[] = [];
  const params: unknown[] = [circleId];
  if (input.name !== undefined) { params.push(input.name.trim()); sets.push(`name = $${params.length}`); }
  if (input.description !== undefined) { params.push(input.description?.trim() || null); sets.push(`description = $${params.length}`); }
  if (input.parentCircleId !== undefined) { params.push(input.parentCircleId); sets.push(`parent_circle_id = $${params.length}`); }
  if (!sets.length) return;
  try {
    await query(`UPDATE circles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A circle with that name already exists here');
    }
    throw err;
  }
}

/** Archive, never delete — every member/post row survives (spec §6). */
export async function archiveCircle(circleId: string): Promise<void> {
  const r = await query(
    `UPDATE circles SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (r.rowCount === 0) throw new NotFoundError('Circle', circleId);
}

// ── Pod attachment (admin) ───────────────────────────────────────────────────

export async function attachPod(circleId: string, podId: string, adminUserId: string): Promise<void> {
  const circle = await query(`SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  const pod = await query(`SELECT id FROM pods WHERE id = $1`, [podId]);
  if (pod.rows.length === 0) throw new NotFoundError('Pod', podId);
  await query(
    `INSERT INTO circle_pods (circle_id, pod_id, added_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [circleId, podId, adminUserId],
  );
}

export async function detachPod(circleId: string, podId: string): Promise<void> {
  await query(`DELETE FROM circle_pods WHERE circle_id = $1 AND pod_id = $2`, [circleId, podId]);
}

// ── Membership (open join — flagged default, spec §10) ───────────────────────

export async function joinCircle(circleId: string, userId: string): Promise<void> {
  const circle = await query(`SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);

  await transaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO circle_members (circle_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [circleId, userId],
    );
    // Counter moves in the SAME transaction as the membership row, and only
    // when a row was actually inserted — a double-join can't double-count.
    if (ins.rowCount && ins.rowCount > 0) {
      await client.query(
        `UPDATE circles SET member_count = member_count + 1 WHERE id = $1`, [circleId]);
    }
  });
}

export async function leaveCircle(circleId: string, userId: string): Promise<void> {
  await transaction(async (client) => {
    const del = await client.query(
      `DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2`,
      [circleId, userId],
    );
    if (del.rowCount && del.rowCount > 0) {
      await client.query(
        `UPDATE circles SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1`, [circleId]);
    }
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listCircles(userId: string): Promise<CircleSummary[]> {
  const r = await query<{
    id: string; name: string; description: string | null;
    parent_circle_id: string | null; member_count: number;
    pod_count: string; is_member: boolean; created_at: Date;
  }>(
    `SELECT c.id, c.name, c.description, c.parent_circle_id, c.member_count, c.created_at,
            (SELECT count(*) FROM circle_pods cp WHERE cp.circle_id = c.id)::text AS pod_count,
            EXISTS(SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $1) AS is_member
     FROM circles c
     WHERE c.archived_at IS NULL
     ORDER BY c.member_count DESC, c.created_at ASC`,
    [userId],
  );
  return r.rows.map(c => ({
    id: c.id, name: c.name, description: c.description,
    parentCircleId: c.parent_circle_id, memberCount: c.member_count,
    podCount: parseInt(c.pod_count, 10), isMember: c.is_member, createdAt: c.created_at,
  }));
}

/** Which circles is this pod attached to (pod page chips, P3b). */
export async function listCirclesOfPod(podId: string): Promise<Array<{ id: string; name: string }>> {
  const r = await query<{ id: string; name: string }>(
    `SELECT c.id, c.name
     FROM circle_pods cp JOIN circles c ON c.id = cp.circle_id
     WHERE cp.pod_id = $1 AND c.archived_at IS NULL
     ORDER BY c.name ASC`,
    [podId],
  );
  return r.rows;
}

export async function getCircleDetail(circleId: string, userId: string): Promise<CircleDetail> {
  const c = await query<{
    id: string; name: string; description: string | null;
    parent_circle_id: string | null; member_count: number; created_at: Date;
    is_member: boolean;
  }>(
    `SELECT c.id, c.name, c.description, c.parent_circle_id, c.member_count, c.created_at,
            EXISTS(SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $2) AS is_member
     FROM circles c WHERE c.id = $1 AND c.archived_at IS NULL`,
    [circleId, userId],
  );
  const circle = c.rows[0];
  if (!circle) throw new NotFoundError('Circle', circleId);

  // Three indexed queries, no N+1: members (joined users), pods, events of
  // those pods. Members capped at 100 for the page; full list can paginate later.
  const [members, pods, events, children] = await Promise.all([
    query<{ user_id: string; display_name: string | null; avatar_url: string | null; role: string; joined_at: Date }>(
      `SELECT m.user_id, u.display_name, u.avatar_url, m.role, m.joined_at
       FROM circle_members m JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = $1 ORDER BY m.joined_at ASC LIMIT 100`,
      [circleId],
    ),
    query<{ pod_id: string; name: string; description: string | null }>(
      `SELECT cp.pod_id, p.name, p.description
       FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id
       WHERE cp.circle_id = $1 ORDER BY cp.created_at ASC`,
      [circleId],
    ),
    query<{ id: string; title: string; scheduled_at: Date; pod_id: string }>(
      `SELECT s.id, s.title, s.scheduled_at, s.pod_id
       FROM sessions s
       WHERE s.pod_id IN (SELECT pod_id FROM circle_pods WHERE circle_id = $1)
         AND s.status = 'scheduled' AND s.scheduled_at > NOW()
       ORDER BY s.scheduled_at ASC LIMIT 10`,
      [circleId],
    ),
    query<{ id: string; name: string; member_count: number }>(
      `SELECT id, name, member_count FROM circles
       WHERE parent_circle_id = $1 AND archived_at IS NULL
       ORDER BY member_count DESC`,
      [circleId],
    ),
  ]);

  return {
    id: circle.id, name: circle.name, description: circle.description,
    parentCircleId: circle.parent_circle_id, memberCount: circle.member_count,
    isMember: circle.is_member, createdAt: circle.created_at,
    members: members.rows.map(m => ({
      userId: m.user_id, displayName: m.display_name, avatarUrl: m.avatar_url,
      role: m.role, joinedAt: m.joined_at,
    })),
    pods: pods.rows.map(p => ({ podId: p.pod_id, name: p.name, description: p.description })),
    upcomingEvents: events.rows.map(e => ({
      id: e.id, title: e.title, scheduledAt: e.scheduled_at, podId: e.pod_id,
    })),
    children: children.rows.map(ch => ({ id: ch.id, name: ch.name, memberCount: ch.member_count })),
  };
}
