// ─── Pod Service ─────────────────────────────────────────────────────────────
// Handles pod CRUD, membership management, and pod configuration.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Pod, PodMember, CreatePodInput, UpdatePodInput,
  PodType, PodStatus, PodMemberRole, PodMemberStatus,
  PodVisibility, PodJoinConfig, podTypeRule,
} from '@rsn/shared';
import { NotFoundError, ConflictError, ForbiddenError } from '../../middleware/errors';
import { UserRole, hasRoleAtLeast } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';

// ─── Column select helpers ──────────────────────────────────────────────────

/** Each pod's member count as members see it (T2): active memberships of active accounts, the list's own rule. */
const ACTIVE_MEMBER_COUNTS = `SELECT pm.pod_id, COUNT(*) AS cnt
    FROM pod_members pm JOIN users u ON u.id = pm.user_id
   WHERE pm.status = 'active' AND ${activeMemberSql('u')}
   GROUP BY pm.pod_id`;

const POD_COLUMNS = `
  id, name, description, pod_type AS "podType", orchestration_mode AS "orchestrationMode",
  communication_mode AS "communicationMode",
  CASE WHEN visibility::text = 'invite_only' THEN 'private' ELSE visibility::text END AS visibility,
  status, max_members AS "maxMembers",
  rules, join_config AS "joinConfig", config, allow_member_invites AS "allowMemberInvites",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
`;

/**
 * "The account $n is a member's, not an event guest's" (Part 2, Task 3, fix round 1). Pod membership is for members:
 * every pod_members write in addMember carries it, so no path (a director adding someone, an invite, a join) can put
 * a guest in a pod.
 */
const MEMBER_ACCOUNT_SQL = (userParam: '$2' | '$4') =>
  `EXISTS (SELECT 1 FROM users acct WHERE acct.id = ${userParam} AND acct.account_kind = 'member')`;

/** What someone adding an event guest to a pod is told. */
export const GUEST_POD_REFUSAL = 'This person came to an event as a guest and is not a member yet, so they cannot join a pod.';
const guestCannotJoinPod = () => new ForbiddenError(GUEST_POD_REFUSAL);

const MEMBER_COLUMNS = `
  pod_members.id, pod_id AS "podId", user_id AS "userId", pod_members.role, pod_members.status,
  joined_at AS "joinedAt", left_at AS "leftAt"
`;

// ─── Pod CRUD ───────────────────────────────────────────────────────────────

/**
 * Make a pod, with its creator as its director. T14 (1 Nov 2026): the pod row and the director row are written in one
 * transaction (they were two separate queries, so a failure between them left a pod nobody directed), and a pod made
 * from a circle's page (`input.circleId`) is attached to that circle in the same transaction: an archived or missing
 * circle is a 404 and nothing is left behind. Who may add a pod to a circle is the route's check, made first.
 */
export async function createPod(userId: string, input: CreatePodInput): Promise<Pod> {
  const podId = uuid();
  // 26 Oct 2026 (Claus, 25 Oct: "orchestration should follow the pod type") — an orchestration or
  // communication the body leaves out comes from the type's definition (a Reason pod is Freeform). Nothing is
  // refused: production's form still posts any combination, and an old pod reads through effectiveOrchestration.
  const podType = input.podType || PodType.SPEED_NETWORKING;
  const typeRule = podTypeRule(podType);

  const pod = await transaction(async (client) => {
    const result = await client.query<Pod>(
      `INSERT INTO pods (id, name, description, pod_type, orchestration_mode, communication_mode, visibility, status, max_members, rules, created_by, allow_member_invites)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11)
       RETURNING ${POD_COLUMNS}`,
      [
        podId,
        input.name,
        input.description || null,
        podType,
        input.orchestrationMode || typeRule.orchestration.default,
        input.communicationMode || typeRule.communication,
        normalisePodVisibility(input.visibility) ?? PodVisibility.PRIVATE,
        input.maxMembers || null,
        input.rules || null,
        userId,
        input.allowMemberInvites ?? false,
      ]
    );

    // Auto-add creator as director
    await client.query(
      `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`,
      [podId, userId]
    );

    if (input.circleId) {
      const linked = await client.query(
        `INSERT INTO circle_pods (circle_id, pod_id, added_by)
         SELECT c.id, $2, $3 FROM circles c WHERE c.id = $1 AND c.archived_at IS NULL
         ON CONFLICT DO NOTHING`,
        [input.circleId, podId, userId],
      );
      if (!linked.rowCount) throw new NotFoundError('Circle', input.circleId);
    }
    return result.rows[0];
  });

  logger.info({ podId, userId, name: input.name, circleId: input.circleId ?? null }, 'Pod created');
  return pod;
}

/**
 * Each pod's event count, as the pod lists and pages show it. A draft (Part 2 Task 2, fix round 1) is nobody's but its
 * organisers', so it is not counted: the count names only events a member could find.
 */
const PUBLISHED_EVENT_COUNTS = `SELECT pod_id, COUNT(*) AS cnt FROM sessions WHERE publication = 'published' GROUP BY pod_id`;

export async function getPodById(podId: string): Promise<Pod & { memberCount?: number; sessionCount?: number; directorName?: string | null; directorId?: string | null }> {
  const result = await query<Pod & { memberCount: number; sessionCount: number; directorName: string | null; directorId: string | null }>(
    `SELECT ${POD_COLUMNS},
            COALESCE(mc.cnt, 0)::int AS "memberCount",
            COALESCE(sc.cnt, 0)::int AS "sessionCount",
            dir.display_name AS "directorName",
            dir.user_id AS "directorId"
     FROM pods
     LEFT JOIN (${ACTIVE_MEMBER_COUNTS}) mc ON mc.pod_id = pods.id
     LEFT JOIN (${PUBLISHED_EVENT_COUNTS}) sc ON sc.pod_id = pods.id
     LEFT JOIN (
       SELECT pm.pod_id, pm.user_id, u.display_name
       FROM pod_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.role = 'director' AND pm.status = 'active' AND ${activeMemberSql('u')}
     ) dir ON dir.pod_id = pods.id
     WHERE pods.id = $1`,
    [podId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Pod', podId);
  }
  return result.rows[0];
}

/** S2: what a host is told on trying to change who may find, join or invite to the pod. */
export const ONLY_DIRECTOR_SETS_ACCESS = "Only the pod's director can change who can find, join or invite to it.";

export async function updatePod(podId: string, userId: string, input: UpdatePodInput, userRole?: UserRole): Promise<Pod> {
  const pod = await getPodById(podId);
  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);
    // Shirley pilot S2: who may find and enter the pod is its director's choice (the edit form is the director's), so
    // a host cannot turn a private pod public, nor who may invite.
    if (('visibility' in input || 'allowMemberInvites' in input) && (await getMemberRole(podId, userId)) !== PodMemberRole.DIRECTOR) {
      throw new ForbiddenError(ONLY_DIRECTOR_SETS_ACCESS);
    }
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // All editable fields — director can now change type, modes, visibility, capacity, etc.
  const fieldMap: Record<string, string> = {
    name:              'name',
    description:       'description',
    podType:           'pod_type',
    orchestrationMode: 'orchestration_mode',
    communicationMode: 'communication_mode',
    visibility:        'visibility',
    maxMembers:        'max_members',
    rules:             'rules',
    status:            'status',
    joinConfig:        'join_config',
    allowMemberInvites:'allow_member_invites',
  };

  for (const [key, dbCol] of Object.entries(fieldMap)) {
    if (key in input) {
      const raw = (input as Record<string, unknown>)[key];
      const val = key === 'visibility' ? normalisePodVisibility(raw as string) : raw;
      setClauses.push(`${dbCol} = $${paramIdx}`);
      // joinConfig is stored as JSONB — cast explicitly
      values.push(dbCol === 'join_config' && val !== null ? JSON.stringify(val) : val);
      paramIdx++;
    }
  }

  if (setClauses.length === 0) {
    return pod;
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(podId);
  const result = await query<Pod>(
    `UPDATE pods SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING ${POD_COLUMNS}`,
    values
  );

  logger.info({ podId, userId }, 'Pod updated');
  // Who may see the pod decides which of its events' links carry a tail: each is put right and its organisers' cards
  // told, in the background (event-link.service.ts; imported here when needed, as the session services import this one).
  if ('visibility' in input) {
    void import('../session/event-link.service').then((links) => links.refreshEventLinksOf({ podId }))
      .catch((err) => logger.warn({ err, podId }, 'updatePod: the event links were not brought up to date'));
  }
  return result.rows[0];
}

export async function listPods(params: {
  userId?: string;
  requestingUserId?: string;
  podType?: PodType;
  status?: PodStatus;
  page?: number;
  pageSize?: number;
  browse?: boolean;
}): Promise<{ pods: Pod[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE 1=1';
  const values: unknown[] = [];
  let paramIdx = 1;

  // requestingUserId is used to look up the caller's role in each pod
  let memberRoleJoin = '';
  let memberRoleSelect = 'NULL AS "memberRole"';
  if (params.requestingUserId) {
    memberRoleJoin = ` LEFT JOIN pod_members pm_role ON pm_role.pod_id = p.id AND pm_role.user_id = $${paramIdx} AND pm_role.status = 'active'`;
    memberRoleSelect = 'pm_role.role AS "memberRole"';
    values.push(params.requestingUserId);
    paramIdx++;
  }

  if (params.userId) {
    whereClause += ` AND p.id IN (SELECT pod_id FROM pod_members WHERE user_id = $${paramIdx} AND status = 'active')`;
    values.push(params.userId);
    paramIdx++;
  }

  // Browse mode: show the discoverable pods (public and public_with_approval). S2: an old invite_only row reads as private.
  if (params.browse) {
    whereClause += ` AND p.visibility::text NOT IN ('private', 'invite_only')`;
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
    `SELECT COUNT(*) as count FROM pods p ${memberRoleJoin} ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  values.push(pageSize, offset);
  const result = await query<Pod & { memberCount: number; sessionCount: number; memberRole: string | null }>(
    `SELECT p.id, p.name, p.description, p.pod_type AS "podType", p.orchestration_mode AS "orchestrationMode",
            p.communication_mode AS "communicationMode",
            CASE WHEN p.visibility::text = 'invite_only' THEN 'private' ELSE p.visibility::text END AS visibility,
            p.status, p.max_members AS "maxMembers",
            p.rules, p.join_config AS "joinConfig", p.config,
            p.created_by AS "createdBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
            COALESCE(mc.cnt, 0)::int AS "memberCount",
            COALESCE(sc.cnt, 0)::int AS "sessionCount",
            ${memberRoleSelect}
     FROM pods p
     LEFT JOIN (${ACTIVE_MEMBER_COUNTS}) mc ON mc.pod_id = p.id
     LEFT JOIN (${PUBLISHED_EVENT_COUNTS}) sc ON sc.pod_id = p.id
     ${memberRoleJoin}
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { pods: result.rows, total };
}

// ─── Pod Membership ─────────────────────────────────────────────────────────

/**
 * How someone is coming in (S2 fix round 1): an organiser's own add or approval (the default), their own join, or an
 * invite they accepted. Someone an organiser removed comes back only through the first, or through an organiser's
 * personal invite made after the removal; their own join, a shared link or a plain member's invite is refused in words.
 */
export type PodAdmission = { by: 'organiser' } | { by: 'self' } | { by: 'invite'; invite: ReturningInvite };

export async function addMember(
  podId: string,
  userId: string,
  role: PodMemberRole = PodMemberRole.MEMBER,
  status: PodMemberStatus = PodMemberStatus.ACTIVE,
  admission: PodAdmission = { by: 'organiser' },
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

    // Check capacity (only for active memberships)
    if (pod.maxMembers && status === PodMemberStatus.ACTIVE) {
      // T2: the count the pod shows (a removed, suspended or banned account takes no place).
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM pod_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.pod_id = $1 AND pm.status = 'active' AND ${activeMemberSql('u')}`,
        [podId]
      );
      if (parseInt(countResult.rows[0].count, 10) >= pod.maxMembers) {
        throw new ConflictError('POD_FULL', 'This pod has reached its maximum member count');
      }
    }

    // Check for existing membership
    const existing = await client.query<{ id: string; status: string; removal_kind?: string | null; left_at?: Date | null }>(
      `SELECT id, status, removal_kind, left_at FROM pod_members WHERE pod_id = $1 AND user_id = $2`,
      [podId, userId]
    );

    if (existing.rows.length > 0) {
      const existingStatus = existing.rows[0].status;
      if (existingStatus === 'active') {
        throw new ConflictError('POD_MEMBER_EXISTS', 'User is already an active member of this pod');
      }
      // S2 fix round 1: someone an organiser removed does not come back by themselves.
      if (existing.rows[0].removal_kind === 'removed' && admission.by !== 'organiser') {
        await assertOrganiserReadmits(client, podId, existing.rows[0].left_at ?? null, admission);
      }
      // Reactivate if previously left, removed, declined, or no_response
      const result = await client.query<PodMember>(
        `UPDATE pod_members SET role = $1, status = $2, joined_at = NOW(),
                left_at = CASE WHEN $5::boolean THEN NULL ELSE left_at END,
                removal_kind = CASE WHEN $5::boolean THEN NULL ELSE removal_kind END
         WHERE pod_id = $3 AND user_id = $4
           AND ${MEMBER_ACCOUNT_SQL('$4')}
         RETURNING ${MEMBER_COLUMNS}`,
        // $5: they come back in (active). A pending ask keeps the removal mark and when it happened (S2 fix round 1).
        [role, status, podId, userId, status === PodMemberStatus.ACTIVE]
      );
      if (result.rows.length === 0) throw guestCannotJoinPod();
      return result.rows[0];
    }

    // Part 2, Task 3 (fix round 1): only a member's account is written; an event guest gets no pod_members row.
    const result = await client.query<PodMember>(
      `INSERT INTO pod_members (pod_id, user_id, role, status)
       SELECT $1, $2, $3, $4
        WHERE ${MEMBER_ACCOUNT_SQL('$2')}
       RETURNING ${MEMBER_COLUMNS}`,
      [podId, userId, role, status]
    );
    if (result.rows.length === 0) throw guestCannotJoinPod();

    logger.info({ podId, userId, role }, 'Member added to pod');
    return result.rows[0];
  });
}

export async function removeMember(podId: string, userId: string, removedBy: string, removedByRole?: UserRole): Promise<void> {
  const isAdmin = removedByRole && hasRoleAtLeast(removedByRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, removedBy, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);
    // S2 fix round 1: the director is never removed, and a host removes members only (a host removing the director
    // took the pod from them: its private page turns 404 for them).
    const target = await getMemberRole(podId, userId);
    if (target === PodMemberRole.DIRECTOR) throw new ForbiddenError(DIRECTOR_NOT_REMOVED);
    if (target === PodMemberRole.HOST && (await getMemberRole(podId, removedBy)) !== PodMemberRole.DIRECTOR) {
      throw new ForbiddenError(ONLY_DIRECTOR_REMOVES_HOSTS);
    }
  }

  // S2 fix round 1: an organiser's removal (removal_kind 'removed'): they cannot come back by themselves.
  const result = await query(
    `UPDATE pod_members SET status = 'removed', removal_kind = 'removed', left_at = NOW()
      WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
    [podId, userId]
  );

  // Bug 30 (19 May Ali) — when a member is removed, the OLD invite they
  // accepted to join the pod stays in the DB as status='accepted'. The
  // accept route's addMember call would happily reactivate their pod
  // membership on a re-click of that link, effectively undoing the
  // removal. Revoke every accepted-and-pending invite for this
  // (pod, user) so the only way back in is a fresh invite from the
  // director. Best-effort: a failure here doesn't undo the removal.
  try {
    const userEmailRow = await query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    const email = userEmailRow.rows[0]?.email;
    if (email) {
      await query(
        `UPDATE invites SET status = 'revoked'
         WHERE pod_id = $1
           AND status IN ('accepted', 'pending')
           AND (accepted_by_user_id = $2 OR LOWER(invitee_email) = LOWER($3))`,
        [podId, userId, email],
      );
    }
  } catch { /* non-fatal — removal already committed */ }

  if (result.rowCount === 0) {
    throw new NotFoundError('PodMember');
  }

  logger.info({ podId, userId, removedBy }, 'Member removed from pod');
}

export async function updateMemberRole(podId: string, targetUserId: string, newRole: PodMemberRole, updatedBy: string, updatedByRole?: UserRole): Promise<PodMember> {
  const isAdmin = updatedByRole && hasRoleAtLeast(updatedByRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, updatedBy, [PodMemberRole.DIRECTOR]);
  }

  if (targetUserId === updatedBy && newRole !== PodMemberRole.DIRECTOR) {
    throw new ForbiddenError('You cannot change your own role as director');
  }

  if (newRole === PodMemberRole.DIRECTOR) {
    throw new ForbiddenError('Director role cannot be assigned. Use transfer ownership instead.');
  }

  const result = await query<PodMember>(
    `UPDATE pod_members SET role = $1 WHERE pod_id = $2 AND user_id = $3 AND status = 'active'
     RETURNING ${MEMBER_COLUMNS}`,
    [newRole, podId, targetUserId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('PodMember');
  }

  logger.info({ podId, targetUserId, newRole, updatedBy }, 'Pod member role updated');
  return result.rows[0];
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

export async function getPodMembers(podId: string, status?: PodMemberStatus): Promise<(PodMember & { displayName?: string; email?: string; avatarUrl?: string; jobTitle?: string; company?: string; interests?: string[] })[]> {
  let sql = `SELECT ${MEMBER_COLUMNS}, u.display_name AS "displayName", u.email,
                    u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle", u.company, u.interests
             FROM pod_members
             JOIN users u ON u.id = pod_members.user_id
             WHERE pod_id = $1 AND ${activeMemberSql('u')}`;
  // T2 (1 Nov 2026): an account an admin removed, suspended or banned is not listed, nor counted (getPodById,
  // listPods, getMemberStatusCounts read the same rule).
  const values: unknown[] = [podId];

  if (status) {
    sql += ' AND pod_members.status = $2';
    values.push(status);
  }

  sql += ' ORDER BY joined_at ASC';
  const result = await query<PodMember & { displayName?: string; email?: string; avatarUrl?: string; jobTitle?: string; company?: string; interests?: string[] }>(sql, values);
  return result.rows;
}

export async function getMemberRole(podId: string, userId: string): Promise<PodMemberRole | null> {
  const result = await query<{ role: PodMemberRole }>(
    `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`,
    [podId, userId]
  );
  return result.rows.length > 0 ? result.rows[0].role : null;
}

export async function getMemberStatusCounts(podId: string): Promise<{
  active: number;
  pending_approval: number;
  invited: number;
  declined: number;
  no_response: number;
  left: number;
  removed: number;
  total: number;
  pendingInvites: number;
}> {
  const statusResult = await query<{ status: string; count: string }>(
    `SELECT pm.status, COUNT(*)::text AS count
       FROM pod_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.pod_id = $1 AND ${activeMemberSql('u')}
      GROUP BY pm.status`,
    [podId]
  );

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of statusResult.rows) {
    counts[row.status] = parseInt(row.count, 10);
    if (row.status !== 'removed') {
      total += parseInt(row.count, 10);
    }
  }

  // Count pending pod invites
  const inviteResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM invites
     WHERE pod_id = $1 AND type = 'pod' AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [podId]
  );
  const pendingInvites = parseInt(inviteResult.rows[0]?.count || '0', 10);
  total += pendingInvites;

  return {
    active: counts['active'] || 0,
    pending_approval: counts['pending_approval'] || 0,
    invited: counts['invited'] || 0,
    declined: counts['declined'] || 0,
    no_response: counts['no_response'] || 0,
    left: counts['left'] || 0,
    removed: counts['removed'] || 0,
    total,
    pendingInvites,
  };
}

// ─── Join / Request to Join ──────────────────────────────────────────────────

export async function joinPod(podId: string, userId: string, actorRole?: UserRole): Promise<PodMember> {
  const pod = await getPodById(podId);

  if (pod.status !== PodStatus.ACTIVE) {
    throw new ForbiddenError('This pod is not currently active');
  }

  // A platform admin joins any open pod, whatever its visibility, as an ordinary member. addMember
  // reactivates an earlier removed / declined / left / pending row instead of failing on the unique key.
  if (actorRole && hasRoleAtLeast(actorRole, UserRole.ADMIN)) {
    return addMember(podId, userId, PodMemberRole.MEMBER);
  }

  if (pod.visibility === PodVisibility.PRIVATE || pod.visibility === PodVisibility.INVITE_ONLY) {
    throw new ForbiddenError('This pod requires an invite to join');
  }

  if (pod.visibility === PodVisibility.PUBLIC_WITH_APPROVAL) {
    throw new ForbiddenError('This pod requires approval. Use "Request to Join" instead.');
  }

  // Public: direct join, unless an organiser removed them (S2 fix round 1).
  return addMember(podId, userId, PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, { by: 'self' });
}

export async function requestToJoin(podId: string, userId: string): Promise<PodMember> {
  const pod = await getPodById(podId);

  if (pod.status !== PodStatus.ACTIVE) {
    throw new ForbiddenError('This pod is not currently active');
  }

  if (pod.visibility === PodVisibility.PRIVATE || pod.visibility === PodVisibility.INVITE_ONLY) {
    throw new ForbiddenError('This is a private pod. You need an invite to join.');
  }

  if (pod.visibility === PodVisibility.PUBLIC) {
    // Public pods: join directly rather than requesting, unless an organiser removed them (S2 fix round 1). On an
    // approval pod (below) they may ask again: the organiser decides.
    return addMember(podId, userId, PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, { by: 'self' });
  }

  // public_with_approval → pending approval (S2: an old invite_only row is private, refused above)
  const member = await addMember(podId, userId, PodMemberRole.MEMBER, PodMemberStatus.PENDING_APPROVAL);

  // Stefan (2 Jul) — directors/hosts never learned someone asked to join;
  // requests sat invisible until the pod page happened to be reloaded.
  try {
    await notifyApproversOfJoinRequest(pod, userId);
  } catch (err) {
    logger.warn({ err, podId, userId }, 'Join-request notification failed (non-fatal)');
  }

  return member;
}

// Bell notification for everyone who can approve the request (active
// directors + hosts), pushed live via notification:new + entity tags —
// same pattern as invites, DMs, and pokes.
async function notifyApproversOfJoinRequest(pod: Pod, requesterId: string): Promise<void> {
  const requesterResult = await query<{ display_name: string | null; email: string | null }>(
    `SELECT display_name, email FROM users WHERE id = $1`,
    [requesterId]
  );
  const requesterName = requesterResult.rows[0]?.display_name || requesterResult.rows[0]?.email || 'Someone';
  const title = 'New Join Request';
  const body = `${requesterName} wants to join ${pod.name}`;
  const link = `/pods/${pod.id}`;

  const inserted = await query<{ id: string; user_id: string; created_at: Date }>(
    `INSERT INTO notifications (user_id, type, title, body, link)
     SELECT user_id, 'join_request', $2, $3, $4
       FROM pod_members
      WHERE pod_id = $1 AND role IN ('director', 'host') AND status = 'active' AND user_id <> $5
     RETURNING id, user_id, created_at`,
    [pod.id, title, body, link, requesterId]
  );
  if (inserted.rows.length === 0) return;

  try {
    const { io } = await import('../../index');
    for (const row of inserted.rows) {
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id,
        type: 'join_request',
        title,
        body,
        link,
        isRead: false,
        createdAt: row.created_at,
      });
    }
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    // One emit per director or host with their own tag (H2b review M6), never every one's tag to each of them.
    for (const row of inserted.rows) {
      emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]).catch(() => {});
    }
  } catch { /* socket push is non-fatal */ }
}

export async function approveMember(podId: string, memberUserId: string, approvedBy: string, approvedByRole?: UserRole): Promise<PodMember> {
  const isAdmin = approvedByRole && hasRoleAtLeast(approvedByRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, approvedBy, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);
  }

  const result = await query<PodMember>(
    `UPDATE pod_members SET status = 'active', joined_at = NOW(), left_at = NULL, removal_kind = NULL
     WHERE pod_id = $1 AND user_id = $2 AND status = 'pending_approval'
     RETURNING ${MEMBER_COLUMNS}`,
    [podId, memberUserId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('PendingMember');
  }

  logger.info({ podId, memberUserId, approvedBy }, 'Pod join request approved');
  return result.rows[0];
}

export async function rejectMember(podId: string, memberUserId: string, rejectedBy: string, rejectedByRole?: UserRole): Promise<void> {
  const isAdmin = rejectedByRole && hasRoleAtLeast(rejectedByRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, rejectedBy, [PodMemberRole.DIRECTOR, PodMemberRole.HOST]);
  }

  const result = await query(
    `UPDATE pod_members SET status = 'removed', left_at = NOW(), removal_kind = COALESCE(removal_kind, 'rejected')
     WHERE pod_id = $1 AND user_id = $2 AND status = 'pending_approval'`,
    [podId, memberUserId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('PendingMember');
  }

  logger.info({ podId, memberUserId, rejectedBy }, 'Pod join request rejected');
}

/** Mark an invited member as declined. Called when the invitee explicitly refuses. */
export async function declineMember(podId: string, userId: string): Promise<void> {
  const result = await query(
    `UPDATE pod_members SET status = 'declined', left_at = NOW()
     WHERE pod_id = $1 AND user_id = $2 AND status IN ('invited', 'pending_approval')`,
    [podId, userId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('PodMember');
  }

  logger.info({ podId, userId }, 'Pod invitation declined');
}

// ─── Join Config ─────────────────────────────────────────────────────────────

export async function getJoinConfig(podId: string): Promise<PodJoinConfig | null> {
  const result = await query<{ joinConfig: PodJoinConfig | null }>(
    `SELECT join_config AS "joinConfig" FROM pods WHERE id = $1`,
    [podId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pod', podId);
  return result.rows[0].joinConfig;
}

export async function setJoinConfig(podId: string, userId: string, config: PodJoinConfig | null, userRole?: UserRole): Promise<void> {
  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR]);
  }

  await query(
    `UPDATE pods SET join_config = $1, updated_at = NOW() WHERE id = $2`,
    [config ? JSON.stringify(config) : null, podId]
  );

  logger.info({ podId, userId }, 'Pod join config updated');
}

// ─── Delete Pod ─────────────────────────────────────────────────────────────

export async function deletePod(podId: string, userId: string, userRole?: UserRole): Promise<void> {
  await getPodById(podId);

  const isAdmin = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);
  if (!isAdmin) {
    await requirePodRole(podId, userId, [PodMemberRole.DIRECTOR]);
  }

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
    `SELECT COUNT(*) as count FROM sessions WHERE pod_id = $1 AND publication = 'published'`,
    [podId]
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Hard Delete Pod (super_admin only) ─────────────────────────────────────

export async function hardDeletePod(podId: string): Promise<void> {
  await getPodById(podId);

  await transaction(async (client) => {
    await client.query(`DELETE FROM invites WHERE pod_id = $1`, [podId]);
    const sessionsResult = await client.query<{ id: string }>(`SELECT id FROM sessions WHERE pod_id = $1`, [podId]);
    for (const s of sessionsResult.rows) {
      await client.query(`DELETE FROM ratings WHERE match_id IN (SELECT id FROM matches WHERE session_id = $1)`, [s.id]);
      await client.query(`DELETE FROM matches WHERE session_id = $1`, [s.id]);
      await client.query(`DELETE FROM session_participants WHERE session_id = $1`, [s.id]);
    }
    await client.query(`DELETE FROM sessions WHERE pod_id = $1`, [podId]);
    await client.query(`DELETE FROM pod_members WHERE pod_id = $1`, [podId]);
    await client.query(`DELETE FROM pods WHERE id = $1`, [podId]);
  });

  logger.info({ podId }, 'Pod permanently deleted by admin');
}

// ─── Pod Members for Invite ────────────────────────────────────────────────

// 26 Oct 2026 (fix round 2): the list is made for the person asking (`askerId`, the event's host, a co-host or an admin).
// It leaves out accounts that are not active (suspended, banned or closed) and anyone blocked either way with the
// asker, whoever made the block: they are not offered, and Invite All does not have them skipped one by one. A member
// who declined an invite to the event is still listed: Invite All skips them, and the single Invite may ask again.
export async function getPodMembersForInvite(podId: string, sessionId: string, askerId: string): Promise<{
  userId: string; displayName: string; email: string; avatarUrl: string | null;
}[]> {
  const result = await query<{
    user_id: string; display_name: string; email: string; avatar_url: string | null;
  }>(`
    SELECT u.id AS user_id, u.display_name, u.email, u.avatar_url
    FROM pod_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.pod_id = $1
      AND pm.status = 'active'
      AND u.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = $3 AND b.blocked_id = u.id)
                          OR (b.blocker_id = u.id AND b.blocked_id = $3))
      AND pm.user_id NOT IN (
        SELECT sp.user_id FROM session_participants sp WHERE sp.session_id = $2
      )
      AND pm.user_id NOT IN (
        SELECT i.accepted_by_user_id FROM invites i
        WHERE i.session_id = $2 AND i.status IN ('pending', 'accepted')
        AND i.accepted_by_user_id IS NOT NULL
      )
      AND u.email NOT IN (
        SELECT i.invitee_email FROM invites i
        WHERE i.session_id = $2 AND i.status IN ('pending', 'accepted')
        AND i.invitee_email IS NOT NULL
      )
    ORDER BY u.display_name
  `, [podId, sessionId, askerId]);

  return result.rows.map(r => ({
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    avatarUrl: r.avatar_url,
  }));
}

// ─── Removed is not turned down (S2 fix round 1, controller ruling) ─────────────────────────────────────────────

export const DIRECTOR_NOT_REMOVED = "The pod's director can't be removed.";
export const ONLY_DIRECTOR_REMOVES_HOSTS = "Only the pod's director can remove a host.";
export const REMOVED_FROM_POD = 'You were removed from this pod. Ask its director for an invitation.';
/** S2 fix round 2: the same refusal, said where the person was registering for one of the pod's events. */
export const REMOVED_FROM_EVENT_POD = "This event belongs to a pod you were removed from. Ask the pod's director for an invitation.";

/** 'invite_only' is retired (D2): any that still arrives (an old instance mid-deploy, an old client) is stored Private. */
export function normalisePodVisibility<T extends string | null | undefined>(v: T): T | PodVisibility.PRIVATE {
  return (v as string) === PodVisibility.INVITE_ONLY ? PodVisibility.PRIVATE : v;
}

/** The invite an accept would let someone in with: who made it, for whom, and when. */
export interface ReturningInvite { inviterId: string; inviteeEmail: string | null; maxUses: number; createdAt: Date | string }

/**
 * S2 fix round 1: inside addMember's transaction, for a row an organiser removed. Their own join is refused. An invite
 * readmits them only when an organiser decided it: a personal invite (one address, one use) made AFTER the removal by
 * someone who runs the pod now (an active director or host with an active account, or a platform admin). A shared link,
 * or a plain member's invite, is refused in words.
 */
async function assertOrganiserReadmits(
  client: { query: <R extends Record<string, unknown>>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> },
  podId: string,
  removedAt: Date | null,
  admission: PodAdmission,
): Promise<void> {
  if (admission.by !== 'invite') throw new ForbiddenError(REMOVED_FROM_POD);
  const { invite } = admission;
  const personal = !!invite.inviteeEmail && invite.maxUses <= 1;
  const after = !removedAt || new Date(invite.createdAt).getTime() > new Date(removedAt).getTime();
  if (!personal || !after) throw new ForbiddenError(REMOVED_FROM_POD);
  const r = await client.query<{ runs: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM users a WHERE a.id = $2 AND a.status = 'active' AND a.role IN ('admin', 'super_admin'))
             OR EXISTS (SELECT 1 FROM pod_members o JOIN users ou ON ou.id = o.user_id
                         WHERE o.pod_id = $1 AND o.user_id = $2 AND o.status = 'active' AND o.role IN ('director', 'host')
                           AND ou.status = 'active')) AS runs`,
    [podId, invite.inviterId],
  );
  if (!r.rows[0]?.runs) throw new ForbiddenError(REMOVED_FROM_POD);
}

// ─── Authorization Helpers ──────────────────────────────────────────────────

async function requirePodRole(podId: string, userId: string, roles: PodMemberRole[]): Promise<void> {
  const role = await getMemberRole(podId, userId);
  if (!role || !roles.includes(role)) {
    throw new ForbiddenError(`Requires pod role: ${roles.join(' or ')}`);
  }
}
