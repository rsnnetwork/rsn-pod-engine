// ─── Group DM Service ────────────────────────────────────────────────────────
//
// Phase I of chat-fix-and-dm-system plan (1 May 2026) made the tables and this file; group chats were
// finished on 26 Oct 2026 (COM-04). Stefan, 25 Oct: "Can there be 3, 5, 10, 20, 50 people in a chat? There
// should be." Three group types:
//   - 'event':  started by an organiser of a completed event (its host, a co-host, a director or host of
//               its pod, or an admin) with the people who took part in it. The one the product offers.
//   - 'custom': made through POST /groups from people the creator has met (no screen uses it yet).
//   - 'pod':    one per pod, members synced with pod_members (never wired: the pod wall serves pods).
//
// Every group holds 3 to 50 people, its creator included. The cap is checked under the group's row lock
// (SELECT … FOR UPDATE) by the one function that puts people in, so two adds at once never make 51.
// Members who block each other stay in the group but never see each other's messages (the thread, the
// preview and the unread count all leave them out, in both directions) and never ring each other's bell.
// A message rings each other member's bell at most once per group in 10 minutes, unless their group bell
// is off. Nobody can add someone they have blocked or who has blocked them.
//
// Group messages share the direct_messages table through its group_id column (XOR with conversation_id).

import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import {
  ErrorCodes, GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS, UserRole, hasRoleAtLeast,
  type DmGroupDetail, type DmGroupMember, type DmGroupRole, type DmGroupSummary, type DmGroupType,
  type GroupChatMessage, type GroupChatMessagePage,
} from '@rsn/shared';
import * as blockService from '../block/block.service';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { userRoom } from '../orchestration/state/session-state';

export interface DmGroup {
  id: string;
  name: string;
  type: DmGroupType;
  podId: string | null;
  sessionId: string | null;
  createdBy: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
}

/** What a message rang: the bell's words, and one row per person it was written for. */
export interface GroupBells {
  title: string;
  body: string;
  link: string;
  rows: Array<{ id: string; userId: string; createdAt: Date }>;
}

export interface SentGroupMessage {
  message: GroupChatMessage;
  bells: GroupBells;
}

/** The words people read, for the route and the tests. */
export const GROUP_COPY = {
  full: `This group is full (${GROUP_CHAT_MAX_MEMBERS} people).`,
  tooSmall: `A group chat needs at least ${GROUP_CHAT_MIN_MEMBERS} people.`,
  notFound: 'This group chat could not be found.',
  notMember: 'You are not in this group.',
  eventNotFound: 'This event could not be found.',
  notOrganiser: 'Only the people who ran this event can start a group chat from it.',
  notEnded: 'You can start a group chat after the event ends.',
  notAttendee: 'Only people who took part in this event can be added.',
  blocked: "You can't add someone you can no longer message.",
  notMet: 'You can only add people you have met.',
  noEvent: 'New people can only be added to a group started from an event.',
  adminAdds: "Only the group's admin can add people.",
  adminRemoves: "Only the group's admin can remove people.",
  removeSelf: 'To leave the group, use Leave.',
  memberNotFound: 'This person is not in the group.',
  formerMember: 'Former member',
} as const;

/** How long one bell stands for every message after it in the same group, per person. */
const BELL_QUIET_MINUTES = 10;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
const LIST_MAX = 100;
const NAME_MAX = 200;
const MESSAGE_MAX = 4000;
const PREVIEW_MAX = 200;
const BELL_BODY_MAX = 140;

type Db = Pick<PoolClient, 'query'>;

interface GroupRow {
  id: string;
  name: string;
  type: DmGroupType;
  pod_id: string | null;
  session_id: string | null;
  created_by: string | null;
  last_message_at: Date | null;
  created_at: Date;
}

const GROUP_COLUMNS = 'id, name, type, pod_id, session_id, created_by, last_message_at, created_at';

function toDmGroup(r: GroupRow): DmGroup {
  return {
    id: r.id, name: r.name, type: r.type, podId: r.pod_id, sessionId: r.session_id,
    createdBy: r.created_by, lastMessageAt: r.last_message_at, createdAt: r.created_at,
  };
}

// ─── Small rules ─────────────────────────────────────────────────────────────

/** The first n characters, counted the way the database counts them (a whole emoji is one). */
function excerpt(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

/** A member's name as other members see it: "Former member" once their account is closed. */
function nameOf(displayName: string | null, status: string | null): string {
  if (status !== 'active') return GROUP_COPY.formerMember;
  return (displayName ?? '').trim() || 'Member';
}

function avatarOf(avatarUrl: string | null, status: string | null): string | null {
  return status === 'active' ? avatarUrl : null;
}

const groupFull = () => new ConflictError(ErrorCodes.GROUP_FULL, GROUP_COPY.full);
const groupTooSmall = () => new AppError(400, ErrorCodes.GROUP_TOO_SMALL, GROUP_COPY.tooSmall);
const groupNotFound = (groupId: string) => new NotFoundError('Group', groupId, GROUP_COPY.notFound);

/**
 * Neither of two people has blocked the other: `one` and `other` are column references or placeholders,
 * never values. The thread, the preview, the unread count and the bells all use it, so the two directions
 * cannot drift apart.
 */
const notBlockedBetween = (one: string, other: string) => `NOT EXISTS (
         SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${one} AND b.blocked_id = ${other})
             OR (b.blocker_id = ${other} AND b.blocked_id = ${one}))`;

// ─── Membership, under the group's row lock ──────────────────────────────────

interface LockedGroup {
  id: string;
  name: string;
  type: DmGroupType;
  session_id: string | null;
}

/** Takes the group's row lock for this transaction: every change to its members goes through it. */
async function lockGroup(db: Db, groupId: string): Promise<LockedGroup> {
  const r = await db.query<LockedGroup>(
    `SELECT id, name, type, session_id FROM dm_groups WHERE id = $1 FOR UPDATE`,
    [groupId],
  );
  if (r.rows.length === 0) throw groupNotFound(groupId);
  return r.rows[0];
}

async function memberIdsOf(db: Db, groupId: string): Promise<Set<string>> {
  const r = await db.query<{ user_id: string }>(
    `SELECT user_id FROM dm_group_members WHERE group_id = $1`,
    [groupId],
  );
  return new Set(r.rows.map((row) => row.user_id));
}

async function roleOf(db: Db, groupId: string, userId: string): Promise<DmGroupRole | null> {
  const r = await db.query<{ role: DmGroupRole }>(
    `SELECT role FROM dm_group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId],
  );
  return r.rows[0]?.role ?? null;
}

/**
 * Puts people into a group whose row lock this transaction holds, refusing to go past the cap. The one way
 * anyone joins a group: the count it checks is read under the lock, so a second add waits for the first to
 * commit and then counts its people too. People already in the group are left as they are.
 */
async function insertMembers(
  db: Db,
  groupId: string,
  people: Array<{ userId: string; role: DmGroupRole }>,
): Promise<{ added: string[]; memberCount: number }> {
  const already = await memberIdsOf(db, groupId);
  const fresh = people.filter((p, i) => !already.has(p.userId) && people.findIndex((q) => q.userId === p.userId) === i);
  const memberCount = already.size + fresh.length;
  if (memberCount > GROUP_CHAT_MAX_MEMBERS) throw groupFull();
  if (fresh.length > 0) {
    await db.query(
      `INSERT INTO dm_group_members (group_id, user_id, role)
       SELECT $1, p.user_id, p.role FROM unnest($2::uuid[], $3::text[]) AS p(user_id, role)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, fresh.map((p) => p.userId), fresh.map((p) => p.role)],
    );
  }
  return { added: fresh.map((p) => p.userId), memberCount };
}

/**
 * The people who took part in an event, as every feature of this batch defines it: they joined
 * (joined_at is set), the organisers did not remove them, and their account is open. `among` narrows the
 * read to those people. Ordered by when they joined the event.
 */
async function whoTookPart(db: Db, sessionId: string, among?: string[]): Promise<string[]> {
  const narrowed = among !== undefined;
  const r = await db.query<{ user_id: string }>(
    `SELECT sp.user_id
       FROM session_participants sp
       JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = $1
        AND sp.joined_at IS NOT NULL
        AND sp.status <> 'removed'
        AND u.status = 'active'${narrowed ? `
        AND sp.user_id = ANY($2::uuid[])` : ''}
      ORDER BY sp.joined_at ASC, sp.user_id ASC`,
    narrowed ? [sessionId, among] : [sessionId],
  );
  return r.rows.map((row) => row.user_id);
}

/** Which of `others` have blocked `userId`, or been blocked by them. */
async function blockedWith(db: Db, userId: string, others: string[]): Promise<Set<string>> {
  if (others.length === 0) return new Set();
  const r = await db.query<{ user_id: string }>(
    `SELECT CASE WHEN b.blocker_id = $1 THEN b.blocked_id ELSE b.blocker_id END AS user_id
       FROM user_blocks b
      WHERE (b.blocker_id = $1 AND b.blocked_id = ANY($2::uuid[]))
         OR (b.blocked_id = $1 AND b.blocker_id = ANY($2::uuid[]))`,
    [userId, others],
  );
  return new Set(r.rows.map((row) => row.user_id));
}

/** Holds a group's size to 3–50 with its creator, before anything is written. */
function checkStartingSize(othersCount: number): void {
  const total = othersCount + 1;
  if (total < GROUP_CHAT_MIN_MEMBERS) throw groupTooSmall();
  if (total > GROUP_CHAT_MAX_MEMBERS) throw groupFull();
}

// ─── Starting a group ────────────────────────────────────────────────────────

interface OrganiserRow {
  status: string;
  title: string | null;
  host_user_id: string | null;
  is_cohost: boolean;
  is_pod_organiser: boolean;
}

/**
 * An organiser of a completed event starts a group chat with the people who took part in it: everyone (who
 * is not blocked with them) unless they name whom, and then only people who took part. They are its admin.
 * Named after the event unless they name it. 3 to 50 people, the creator included.
 * `creator.role` is the account role from the verified sign-in token.
 */
export async function createGroupFromEvent(
  creator: { userId: string; role: UserRole },
  sessionId: string,
  input: { name?: string; memberIds?: string[] },
): Promise<DmGroup & { memberCount: number }> {
  const chosen = input.memberIds === undefined
    ? undefined
    : [...new Set(input.memberIds)].filter((id) => id !== creator.userId);

  return transaction(async (client) => {
    const event = await client.query<OrganiserRow>(
      `SELECT s.status, s.title, s.host_user_id,
              EXISTS (SELECT 1 FROM session_cohosts sc WHERE sc.session_id = s.id AND sc.user_id = $2) AS is_cohost,
              EXISTS (SELECT 1 FROM pod_members pm
                       WHERE pm.pod_id = s.pod_id AND pm.user_id = $2
                         AND pm.role IN ('director', 'host') AND pm.status = 'active') AS is_pod_organiser
         FROM sessions s
        WHERE s.id = $1`,
      [sessionId, creator.userId],
    );
    const row = event.rows[0];
    if (!row) throw new NotFoundError('Session', sessionId, GROUP_COPY.eventNotFound);
    const isOrganiser = row.host_user_id === creator.userId || row.is_cohost || row.is_pod_organiser
      || hasRoleAtLeast(creator.role, UserRole.ADMIN);
    if (!isOrganiser) throw new ForbiddenError(GROUP_COPY.notOrganiser);
    if (row.status !== 'completed') throw new ConflictError(ErrorCodes.VALIDATION_ERROR, GROUP_COPY.notEnded);

    const attendees = (await whoTookPart(client, sessionId)).filter((id) => id !== creator.userId);
    let members: string[];
    if (chosen === undefined) {
      const blocked = await blockedWith(client, creator.userId, attendees);
      members = attendees.filter((id) => !blocked.has(id));
    } else {
      const tookPart = new Set(attendees);
      if (chosen.some((id) => !tookPart.has(id))) throw new ForbiddenError(GROUP_COPY.notAttendee);
      if ((await blockedWith(client, creator.userId, chosen)).size > 0) throw new ForbiddenError(GROUP_COPY.blocked);
      members = chosen;
    }
    checkStartingSize(members.length);

    const name = excerpt(input.name?.trim() || row.title?.trim() || 'Group chat', NAME_MAX);
    const inserted = await client.query<GroupRow>(
      `INSERT INTO dm_groups (name, type, session_id, created_by)
       VALUES ($1, 'event', $2, $3)
       RETURNING ${GROUP_COLUMNS}`,
      [name, sessionId, creator.userId],
    );
    const group = inserted.rows[0];
    await lockGroup(client, group.id);
    const { memberCount } = await insertMembers(client, group.id, [
      { userId: creator.userId, role: 'admin' },
      ...members.map((userId) => ({ userId, role: 'member' as const })),
    ]);

    logger.info({ groupId: group.id, sessionId, creatorId: creator.userId, memberCount }, 'Event group chat started');
    return { ...toDmGroup(group), memberCount };
  });
}

/**
 * Create a custom group chat (POST /groups; no screen uses it yet). The caller becomes admin. Every
 * member must be someone the creator has met and is not blocked with. 3 to 50 people with the creator.
 */
export async function createCustomGroup(
  creatorId: string,
  name: string,
  initialMemberIds: string[],
): Promise<DmGroup & { memberCount: number }> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Group name must be 1-200 chars');
  }
  const others = [...new Set(initialMemberIds)].filter((id) => id !== creatorId);
  checkStartingSize(others.length);

  // Encounter-gate every initial member against the creator.
  for (const memberId of others) {
    if (await blockService.areBlocked(creatorId, memberId)) {
      throw new ForbiddenError(GROUP_COPY.blocked);
    }
    const [a, b] = creatorId < memberId ? [creatorId, memberId] : [memberId, creatorId];
    const enc = await query<{ id: string }>(
      `SELECT id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 LIMIT 1`,
      [a, b],
    );
    if (enc.rows.length === 0) throw new ForbiddenError(GROUP_COPY.notMet);
  }

  return transaction(async (client) => {
    const inserted = await client.query<GroupRow>(
      `INSERT INTO dm_groups (name, type, created_by)
       VALUES ($1, 'custom', $2)
       RETURNING ${GROUP_COLUMNS}`,
      [trimmed, creatorId],
    );
    const group = inserted.rows[0];
    await lockGroup(client, group.id);
    const { memberCount } = await insertMembers(client, group.id, [
      { userId: creatorId, role: 'admin' },
      ...others.map((userId) => ({ userId, role: 'member' as const })),
    ]);

    logger.info({ groupId: group.id, creatorId, memberCount }, 'Custom group created');
    return { ...toDmGroup(group), memberCount };
  });
}

// ─── Changing who is in a group ──────────────────────────────────────────────

/**
 * The group's admin adds people who took part in the group's event. Nobody blocked with the admin, either
 * way. People already in the group are skipped; the group never holds more than 50.
 */
export async function addGroupMembers(
  groupId: string,
  adderId: string,
  userIds: string[],
): Promise<{ added: string[]; memberCount: number }> {
  return transaction(async (client) => {
    const group = await lockGroup(client, groupId);
    const role = await roleOf(client, groupId, adderId);
    if (role === null) throw new ForbiddenError(GROUP_COPY.notMember);
    if (role !== 'admin') throw new ForbiddenError(GROUP_COPY.adminAdds);
    if (group.type !== 'event' || group.session_id === null) {
      throw new ConflictError(ErrorCodes.VALIDATION_ERROR, GROUP_COPY.noEvent);
    }

    const already = await memberIdsOf(client, groupId);
    const fresh = [...new Set(userIds)].filter((id) => id !== adderId && !already.has(id));
    if (fresh.length === 0) return { added: [], memberCount: already.size };

    const tookPart = new Set(await whoTookPart(client, group.session_id, fresh));
    if (fresh.some((id) => !tookPart.has(id))) throw new ForbiddenError(GROUP_COPY.notAttendee);
    if ((await blockedWith(client, adderId, fresh)).size > 0) throw new ForbiddenError(GROUP_COPY.blocked);

    const out = await insertMembers(client, groupId, fresh.map((userId) => ({ userId, role: 'member' as const })));
    logger.info({ groupId, adderId, added: out.added.length, memberCount: out.memberCount }, 'Group chat members added');
    return out;
  });
}

/** The group's admin takes someone out of it. Leaving is the member's own action (leaveGroup). */
export async function removeGroupMember(
  groupId: string,
  removerId: string,
  userId: string,
): Promise<{ removedUserId: string }> {
  if (userId === removerId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, GROUP_COPY.removeSelf);
  return transaction(async (client) => {
    await lockGroup(client, groupId);
    const role = await roleOf(client, groupId, removerId);
    if (role === null) throw new ForbiddenError(GROUP_COPY.notMember);
    if (role !== 'admin') throw new ForbiddenError(GROUP_COPY.adminRemoves);
    const removed = await client.query<{ role: DmGroupRole }>(
      `DELETE FROM dm_group_members WHERE group_id = $1 AND user_id = $2 RETURNING role`,
      [groupId, userId],
    );
    if (removed.rows.length === 0) {
      throw new AppError(404, ErrorCodes.GROUP_MEMBER_NOT_FOUND, GROUP_COPY.memberNotFound);
    }
    logger.info({ groupId, removerId, userId }, 'Group chat member removed');
    return { removedUserId: userId };
  });
}

/**
 * A member leaves. When the last admin with an open account leaves, the earliest member with an open account
 * becomes admin (everyone added when the group started joined at the same moment; among them the choice is
 * fixed by id). Leaving a group one is no longer in changes nothing, so a second press of Leave is not an error.
 */
export async function leaveGroup(
  groupId: string,
  userId: string,
): Promise<{ left: boolean; newAdminId: string | null }> {
  return transaction(async (client) => {
    await lockGroup(client, groupId);
    const gone = await client.query<{ role: DmGroupRole }>(
      `DELETE FROM dm_group_members WHERE group_id = $1 AND user_id = $2 RETURNING role`,
      [groupId, userId],
    );
    if (gone.rows.length === 0) return { left: false, newAdminId: null };
    if (gone.rows[0].role !== 'admin') return { left: true, newAdminId: null };

    // An admin whose account is closed cannot act, so they do not count as one who stays, and they are
    // passed over for the hand-over while anyone with an open account is left.
    const adminStays = await client.query(
      `SELECT 1
         FROM dm_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1 AND m.role = 'admin' AND u.status = 'active'
        LIMIT 1`,
      [groupId],
    );
    if (adminStays.rows.length > 0) return { left: true, newAdminId: null };

    const promoted = await client.query<{ user_id: string }>(
      `UPDATE dm_group_members SET role = 'admin'
        WHERE id = (SELECT m.id
                      FROM dm_group_members m
                      JOIN users u ON u.id = m.user_id
                     WHERE m.group_id = $1
                     ORDER BY (u.status = 'active') DESC, m.joined_at ASC, m.id ASC
                     LIMIT 1)
        RETURNING user_id`,
      [groupId],
    );
    const newAdminId = promoted.rows[0]?.user_id ?? null;
    logger.info({ groupId, userId, newAdminId }, 'Group chat admin left; the earliest member is admin now');
    return { left: true, newAdminId };
  });
}

/**
 * Pod chat (never wired: the pod wall serves pods). Idempotent: returns the pod's group if there is one,
 * otherwise makes it with the pod's active members.
 */
export async function ensurePodGroup(podId: string): Promise<DmGroup> {
  return transaction(async (client) => {
    const existing = await client.query<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM dm_groups WHERE pod_id = $1 AND type = 'pod' LIMIT 1`,
      [podId],
    );
    if (existing.rows.length > 0) return toDmGroup(existing.rows[0]);

    const podResult = await client.query<{ name: string; created_by: string | null }>(
      `SELECT name, created_by FROM pods WHERE id = $1`,
      [podId],
    );
    if (podResult.rows.length === 0) {
      throw new NotFoundError('Pod', podId);
    }
    const pod = podResult.rows[0];

    const groupResult = await client.query<GroupRow>(
      `INSERT INTO dm_groups (name, type, pod_id, created_by)
       VALUES ($1, 'pod', $2, $3)
       RETURNING ${GROUP_COLUMNS}`,
      [pod.name, podId, pod.created_by],
    );
    const g = groupResult.rows[0];

    await client.query(
      `INSERT INTO dm_group_members (group_id, user_id, role)
       SELECT $1, pm.user_id,
              CASE WHEN pm.role IN ('director', 'host') THEN 'admin' ELSE 'member' END
       FROM pod_members pm
       WHERE pm.pod_id = $2 AND pm.status = 'active'
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [g.id, podId],
    );

    logger.info({ groupId: g.id, podId }, 'Pod chat auto-provisioned');
    return toDmGroup(g);
  });
}

/** Pod-membership change hook for the pod chat (never wired, as ensurePodGroup). */
export async function syncPodMember(
  podId: string,
  userId: string,
  action: 'add' | 'remove',
): Promise<void> {
  const group = await ensurePodGroup(podId);

  if (action === 'add') {
    await query(
      `INSERT INTO dm_group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [group.id, userId],
    );
  } else {
    await query(
      `DELETE FROM dm_group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, userId],
    );
  }
  logger.info({ podId, userId, action, groupId: group.id }, 'Pod chat membership synced');
}

// ─── Messages and bells ──────────────────────────────────────────────────────

/**
 * A member writes in a group. Under the group's row lock, the message is kept, the group's last activity
 * moves, and the bells are written in the same transaction: so two messages at once take turns, and the
 * second sees the first's bells and does not ring the same people again. A bell goes to every other member
 * whose account is open, who is not blocked with the sender either way, whose group bell is not off, and
 * who has had no bell for this group in the last 10 minutes.
 */
export async function sendGroupMessage(
  groupId: string,
  fromUserId: string,
  content: string,
): Promise<SentGroupMessage> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message cannot be empty');
  }
  if (trimmed.length > MESSAGE_MAX) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message too long (max 4000 characters)');
  }

  return transaction(async (client) => {
    const group = await lockGroup(client, groupId);
    const sender = await client.query<{ display_name: string; avatar_url: string | null }>(
      `SELECT u.display_name, u.avatar_url
         FROM dm_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1 AND m.user_id = $2`,
      [groupId, fromUserId],
    );
    if (sender.rows.length === 0) throw new ForbiddenError(GROUP_COPY.notMember);

    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO direct_messages (group_id, from_user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [groupId, fromUserId, trimmed],
    );
    const { id, created_at: createdAt } = inserted.rows[0];
    await client.query(`UPDATE dm_groups SET last_message_at = $2 WHERE id = $1`, [groupId, createdAt]);

    const senderName = nameOf(sender.rows[0].display_name, 'active');
    const link = `/messages/g/${groupId}`;
    const title = `${senderName} wrote in ‘${group.name}’`;
    const body = excerpt(trimmed, BELL_BODY_MAX);
    const rung = await client.query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT m.user_id, 'group_message', $3, $4, $5
         FROM dm_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
          AND m.user_id <> $2
          AND u.status = 'active'
          AND u.notification_prefs -> 'group_bell' IS DISTINCT FROM 'false'::jsonb
          AND ${notBlockedBetween('m.user_id', '$2')}
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = m.user_id AND n.type = 'group_message' AND n.link = $5
               AND n.created_at > NOW() - INTERVAL '${BELL_QUIET_MINUTES} minutes')
       RETURNING id, user_id, created_at`,
      [groupId, fromUserId, title, body, link],
    );

    return {
      message: {
        id, groupId, fromUserId, senderName, senderAvatarUrl: sender.rows[0].avatar_url,
        content: trimmed, createdAt: new Date(createdAt).toISOString(),
      },
      bells: {
        title, body, link,
        rows: rung.rows.map((r) => ({ id: r.id, userId: r.user_id, createdAt: r.created_at })),
      },
    };
  });
}

/**
 * Pushes each bell a message rang to its person's open tabs (notification:new, as every bell is pushed) and
 * tells their bell list to refresh. Never throws: the message is already kept.
 */
export async function pushGroupBells(bells: GroupBells): Promise<void> {
  const io = getRealtimeIo();
  if (!io || bells.rows.length === 0) return;
  try {
    for (const row of bells.rows) {
      io.to(userRoom(row.userId)).emit('notification:new', {
        id: row.id, type: 'group_message', title: bells.title, body: bells.body, link: bells.link,
        isRead: false, createdAt: row.createdAt,
      });
    }
    await Promise.all(bells.rows.map((row) => emitEntities(io, [row.userId], [E.userNotifications(row.userId)])));
  } catch (err) {
    logger.warn({ err, link: bells.link }, 'Group chat bells could not be pushed (non-fatal)');
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Whether the group exists and the reader is in it; throws the refusal otherwise. */
async function requireMember(groupId: string, userId: string): Promise<DmGroupRole> {
  const r = await query<{ id: string; role: DmGroupRole | null }>(
    `SELECT g.id, me.role
       FROM dm_groups g
       LEFT JOIN dm_group_members me ON me.group_id = g.id AND me.user_id = $2
      WHERE g.id = $1`,
    [groupId, userId],
  );
  if (r.rows.length === 0) throw groupNotFound(groupId);
  if (r.rows[0].role === null) throw new ForbiddenError(GROUP_COPY.notMember);
  return r.rows[0].role;
}

interface SummaryRow {
  id: string;
  name: string;
  type: DmGroupType;
  pod_id: string | null;
  session_id: string | null;
  created_by: string | null;
  created_at: Date;
  my_role: DmGroupRole;
  member_count: number;
  unread_count: number;
  last_content: string | null;
  last_at: Date | null;
  last_from: string | null;
  last_name: string | null;
  last_status: string | null;
}

/**
 * Each group a member is in, as they see it. A member sees only what was written since they (last) joined:
 * leaving deletes their membership row and an add writes a new one, so its joined_at is always the latest
 * join. The unread count is others' messages since they last read the group (or joined it, when they never
 * have); it and the last message leave out anyone blocked with the member, either way. A group with nothing
 * for them to read yet sorts by when they joined it. $1 is the member; `oneGroup` narrows the read to group $2.
 */
function summarySql(oneGroup: boolean): string {
  return `SELECT g.id, g.name, g.type, g.pod_id, g.session_id, g.created_by, g.created_at,
         me.role AS my_role,
         (SELECT COUNT(*)::int FROM dm_group_members c WHERE c.group_id = g.id) AS member_count,
         (SELECT COUNT(*)::int FROM direct_messages d
           WHERE d.group_id = g.id
             AND d.from_user_id <> me.user_id
             AND d.created_at > COALESCE(me.last_read_at, me.joined_at)
             AND ${notBlockedBetween('me.user_id', 'd.from_user_id')}) AS unread_count,
         LEFT(last.content, ${PREVIEW_MAX}) AS last_content, last.created_at AS last_at, last.from_user_id AS last_from,
         lu.display_name AS last_name, lu.status AS last_status
    FROM dm_group_members me
    JOIN dm_groups g ON g.id = me.group_id
    LEFT JOIN LATERAL (
      SELECT d.content, d.created_at, d.from_user_id
        FROM direct_messages d
       WHERE d.group_id = g.id
         AND d.created_at >= me.joined_at
         AND ${notBlockedBetween('me.user_id', 'd.from_user_id')}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT 1
    ) last ON TRUE
    LEFT JOIN users lu ON lu.id = last.from_user_id
   WHERE me.user_id = $1${oneGroup ? ' AND g.id = $2' : ''}
   ORDER BY COALESCE(last.created_at, me.joined_at) DESC, g.id DESC
   LIMIT ${LIST_MAX}`;
}

function toSummary(r: SummaryRow): DmGroupSummary {
  const lastMessage = r.last_at && r.last_from
    ? { content: r.last_content ?? '', at: new Date(r.last_at).toISOString(), fromUserId: r.last_from, senderName: nameOf(r.last_name, r.last_status) }
    : null;
  return {
    id: r.id, name: r.name, type: r.type, podId: r.pod_id, sessionId: r.session_id, createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(), lastMessageAt: lastMessage?.at ?? null,
    memberCount: r.member_count, unreadCount: r.unread_count, lastMessage, myRole: r.my_role,
  };
}

/** The groups a member is in, the most recent activity first (up to 100). */
export async function listMyGroups(userId: string): Promise<DmGroupSummary[]> {
  const result = await query<SummaryRow>(summarySql(false), [userId]);
  return result.rows.map(toSummary);
}

/** One group as its member sees it, with its members (admin first, then by when they joined) and the cap. */
export async function getGroup(groupId: string, userId: string): Promise<DmGroupDetail> {
  await requireMember(groupId, userId);
  const [summary, members] = await Promise.all([
    query<SummaryRow>(summarySql(true), [userId, groupId]),
    query<{ user_id: string; role: DmGroupRole; joined_at: Date; display_name: string; avatar_url: string | null; status: string }>(
      `SELECT m.user_id, m.role, m.joined_at, u.display_name, u.avatar_url, u.status
         FROM dm_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY (m.role = 'admin') DESC, m.joined_at ASC, m.user_id ASC`,
      [groupId],
    ),
  ]);
  if (summary.rows.length === 0) throw new ForbiddenError(GROUP_COPY.notMember);
  return {
    ...toSummary(summary.rows[0]),
    maxMembers: GROUP_CHAT_MAX_MEMBERS,
    members: members.rows.map((m): DmGroupMember => ({
      userId: m.user_id, displayName: nameOf(m.display_name, m.status), avatarUrl: avatarOf(m.avatar_url, m.status),
      role: m.role, joinedAt: new Date(m.joined_at).toISOString(),
    })),
  };
}

/**
 * A page of a group's messages, newest first, without any from someone blocked with the reader either way,
 * and none from before the reader (last) joined the group: someone added later, or added again, starts there.
 * `before` is a message id: the page holds messages strictly older than it, by (created_at, id), so a page
 * never repeats or skips a message however many share a moment. Page size 1–100, 50 by default.
 */
export async function listGroupMessages(
  groupId: string,
  userId: string,
  options: { before?: string; limit?: number },
): Promise<GroupChatMessagePage> {
  await requireMember(groupId, userId);
  const limit = Math.min(Math.max(options.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const result = await query<{
    id: string; from_user_id: string; content: string | null; created_at: Date;
    display_name: string; avatar_url: string | null; status: string;
  }>(
    `SELECT d.id, d.from_user_id, d.content, d.created_at, u.display_name, u.avatar_url, u.status
       FROM direct_messages d
       JOIN users u ON u.id = d.from_user_id
       JOIN dm_group_members me ON me.group_id = d.group_id AND me.user_id = $2
      WHERE d.group_id = $1
        AND d.created_at >= me.joined_at
        AND ${notBlockedBetween('$2', 'd.from_user_id')}
        AND ($3::uuid IS NULL OR (d.created_at, d.id) < (SELECT c.created_at, c.id FROM direct_messages c WHERE c.id = $3::uuid AND c.group_id = $1))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $4`,
    [groupId, userId, options.before ?? null, limit + 1],
  );
  const rows = result.rows.slice(0, limit);
  return {
    messages: rows.map((r) => ({
      id: r.id, groupId, fromUserId: r.from_user_id,
      senderName: nameOf(r.display_name, r.status), senderAvatarUrl: avatarOf(r.avatar_url, r.status),
      content: r.content ?? '', createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

/** The member has read the group up to now. */
export async function markGroupRead(groupId: string, userId: string): Promise<{ lastReadAt: string }> {
  const marked = await query<{ last_read_at: Date }>(
    `UPDATE dm_group_members SET last_read_at = NOW()
      WHERE group_id = $1 AND user_id = $2
      RETURNING last_read_at`,
    [groupId, userId],
  );
  if (marked.rows.length > 0) return { lastReadAt: new Date(marked.rows[0].last_read_at).toISOString() };
  const exists = await query<{ id: string }>(`SELECT id FROM dm_groups WHERE id = $1`, [groupId]);
  if (exists.rows.length === 0) throw groupNotFound(groupId);
  throw new ForbiddenError(GROUP_COPY.notMember);
}
