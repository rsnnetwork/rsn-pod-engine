// ─── Pod Service ─────────────────────────────────────────────────────────────
// Handles pod CRUD, membership management, and pod configuration.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Pod, PodMember, CreatePodInput, UpdatePodInput,
  PodType, PodStatus, PodMemberRole, PodMemberStatus,
  OrchestrationMode, CommunicationMode, PodVisibility,
} from '@rsn/shared';
import { NotFoundError, ConflictError, ForbiddenError } from '../../middleware/errors';

// ─── Column select helpers ──────────────────────────────────────────────────

const POD_COLUMNS = `
  id, name, description, pod_type AS "podType", orchestration_mode AS "orchestrationMode",
  communication_mode AS "communicationMode", visibility, status, max_members AS "maxMembers",
  rules, config, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const MEMBER_COLUMNS = `
  id, pod_id AS "podId", user_id AS "userId", role, status,
  joined_at AS "joinedAt", left_at AS "leftAt"
`;

// ─── Pod CRUD ───────────────────────────────────────────────────────────────

export async function createPod(userId: string, input: CreatePodInput): Promise<Pod> {
  const podId = uuid();

  const result = await query<Pod>(
    `INSERT INTO pods (id, name, description, pod_type, orchestration_mode, communication_mode, visibility, status, max_members, rules, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10)
     RETURNING ${POD_COLUMNS}`,
    [
      podId,
      input.name,
      input.description || null,
      input.podType || PodType.SPEED_NETWORKING,
      input.orchestrationMode || OrchestrationMode.TIMED_ROUNDS,
      input.communicationMode || CommunicationMode.VIDEO,
      input.visibility || PodVisibility.INVITE_ONLY,
      input.maxMembers || null,
      input.rules || null,
      userId,
    ]
  );

  // Auto-add creator as director
  await query(
    `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`,
    [podId, userId]
  );

  logger.info({ podId, userId, name: input.name }, 'Pod created');
  return result.rows[0];
}

export async function getPodById(podId: string): Promise<Pod> {
  const result = await query<Pod>(
    `SELECT ${POD_COLUMNS} FROM pods WHERE id = $1`,
    [podId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Pod', podId);
  }
  return result.rows[0];
}

export async function updatePod(podId: string, userId: string, input: UpdatePodInput): Promise<Pod> {
  const pod = await getPodById(podId);
  await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    visibility: 'visibility',
    maxMembers: 'max_members',
    rules: 'rules',
    status: 'status',
  };

  for (const [key, dbCol] of Object.entries(fieldMap)) {
    if (key in input) {
      setClauses.push(`${dbCol} = $${paramIdx}`);
      values.push((input as Record<string, unknown>)[key]);
      paramIdx++;
    }
  }

  if (setClauses.length === 0) {
    return pod;
  }

  values.push(podId);
  const result = await query<Pod>(
    `UPDATE pods SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING ${POD_COLUMNS}`,
    values
  );

  logger.info({ podId, userId }, 'Pod updated');
  return result.rows[0];
}

export async function listPods(params: {
  userId?: string;
  podType?: PodType;
  status?: PodStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ pods: Pod[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE 1=1';
  const values: unknown[] = [];
  let paramIdx = 1;

  if (params.userId) {
    whereClause += ` AND p.id IN (SELECT pod_id FROM pod_members WHERE user_id = $${paramIdx} AND status = 'active')`;
    values.push(params.userId);
    paramIdx++;
  }

  if (params.podType) {
    whereClause += ` AND p.pod_type = $${paramIdx}`;
    values.push(params.podType);
    paramIdx++;
  }

  if (params.status) {
    whereClause += ` AND p.status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pods p ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(pageSize, offset);
  const result = await query<Pod & { memberCount: number; sessionCount: number }>(
    `SELECT p.id, p.name, p.description, p.pod_type AS "podType", p.orchestration_mode AS "orchestrationMode",
            p.communication_mode AS "communicationMode", p.visibility, p.status, p.max_members AS "maxMembers",
            p.rules, p.config, p.created_by AS "createdBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
            COALESCE(mc.cnt, 0)::int AS "memberCount",
            COALESCE(sc.cnt, 0)::int AS "sessionCount"
     FROM pods p
     LEFT JOIN (SELECT pod_id, COUNT(*) AS cnt FROM pod_members WHERE status = 'active' GROUP BY pod_id) mc ON mc.pod_id = p.id
     LEFT JOIN (SELECT pod_id, COUNT(*) AS cnt FROM sessions GROUP BY pod_id) sc ON sc.pod_id = p.id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { pods: result.rows, total };
}

// ─── Pod Membership ─────────────────────────────────────────────────────────

export async function addMember(
  podId: string,
  userId: string,
  role: PodMemberRole = PodMemberRole.MEMBER,
  status: PodMemberStatus = PodMemberStatus.ACTIVE
): Promise<PodMember> {
  return transaction(async (client) => {
    // Lock the pod row to serialize concurrent member additions
    const podResult = await client.query<Pod>(
      `SELECT ${POD_COLUMNS} FROM pods WHERE id = $1 FOR UPDATE`,
      [podId]
    );
    if (podResult.rows.length === 0) {
      throw new NotFoundError('Pod', podId);
    }
    const pod = podResult.rows[0];

    // Check capacity
    if (pod.maxMembers) {
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM pod_members WHERE pod_id = $1 AND status = 'active'`,
        [podId]
      );
      if (parseInt(countResult.rows[0].count, 10) >= pod.maxMembers) {
        throw new ConflictError('POD_FULL', 'This pod has reached its maximum member count');
      }
    }

    // Check for existing membership
    const existing = await client.query(
      `SELECT id, status FROM pod_members WHERE pod_id = $1 AND user_id = $2`,
      [podId, userId]
    );

    if (existing.rows.length > 0) {
      const existingStatus = existing.rows[0].status;
      if (existingStatus === 'active') {
        throw new ConflictError('POD_MEMBER_EXISTS', 'User is already an active member of this pod');
      }
      // Reactivate if previously left or removed
      const result = await client.query<PodMember>(
        `UPDATE pod_members SET role = $1, status = $2, joined_at = NOW(), left_at = NULL
         WHERE pod_id = $3 AND user_id = $4
         RETURNING ${MEMBER_COLUMNS}`,
        [role, status, podId, userId]
      );
      return result.rows[0];
    }

    const result = await client.query<PodMember>(
      `INSERT INTO pod_members (pod_id, user_id, role, status)
       VALUES ($1, $2, $3, $4)
       RETURNING ${MEMBER_COLUMNS}`,
      [podId, userId, role, status]
    );

    logger.info({ podId, userId, role }, 'Member added to pod');
    return result.rows[0];
  });
}

export async function removeMember(podId: string, userId: string, removedBy: string): Promise<void> {
  await requirePodRole(podId, removedBy, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);

  const result = await query(
    `UPDATE pod_members SET status = 'removed', left_at = NOW() WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
    [podId, userId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('PodMember');
  }

  logger.info({ podId, userId, removedBy }, 'Member removed from pod');
}

export async function leavePod(podId: string, userId: string): Promise<void> {
  const result = await query(
    `UPDATE pod_members SET status = 'left', left_at = NOW() WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
    [podId, userId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('PodMember');
  }

  logger.info({ podId, userId }, 'Member left pod');
}

export async function getPodMembers(podId: string, status?: PodMemberStatus): Promise<PodMember[]> {
  let sql = `SELECT ${MEMBER_COLUMNS} FROM pod_members WHERE pod_id = $1`;
  const values: unknown[] = [podId];

  if (status) {
    sql += ' AND status = $2';
    values.push(status);
  }

  sql += ' ORDER BY joined_at ASC';
  const result = await query<PodMember>(sql, values);
  return result.rows;
}

export async function getMemberRole(podId: string, userId: string): Promise<PodMemberRole | null> {
  const result = await query<{ role: PodMemberRole }>(
    `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
    [podId, userId]
  );
  return result.rows.length > 0 ? result.rows[0].role : null;
}

// ─── Delete Pod ─────────────────────────────────────────────────────────────

export async function deletePod(podId: string, userId: string): Promise<void> {
  await getPodById(podId);
  await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR]);

  // Soft-delete: archive the pod
  await query(`UPDATE pods SET status = 'archived', updated_at = NOW() WHERE id = $1`, [podId]);
  logger.info({ podId, userId }, 'Pod deleted (archived)');
}

export async function reactivatePod(podId: string, userId: string): Promise<Pod> {
  const pod = await getPodById(podId);
  if (pod.status !== 'archived') {
    throw new ConflictError('POD_NOT_ARCHIVED', 'Only archived pods can be reactivated');
  }
  await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR]);

  const result = await query<Pod>(
    `UPDATE pods SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING ${POD_COLUMNS}`,
    [podId]
  );
  logger.info({ podId, userId }, 'Pod reactivated');
  return result.rows[0];
}

export async function getSessionCountForPod(podId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM sessions WHERE pod_id = $1`,
    [podId]
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Authorization Helpers ──────────────────────────────────────────────────

async function requirePodRole(podId: string, userId: string, roles: PodMemberRole[]): Promise<void> {
  const role = await getMemberRole(podId, userId);
  if (!role || !roles.includes(role)) {
    throw new ForbiddenError(`Requires pod role: ${roles.join(' or ')}`);
  }
}
