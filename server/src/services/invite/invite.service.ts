// ─── Invite Service ──────────────────────────────────────────────────────────
// Handles invite creation, acceptance, status tracking, and validation.

import { customAlphabet } from 'nanoid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import {
  Invite, InviteStatus, InviteType, CreateInviteInput, Session, eventDurationMinutes, resolveEventFormat,
} from '@rsn/shared';
import { NotFoundError, ConflictError, AppError } from '../../middleware/errors';
import * as podService from '../pod/pod.service';
import * as sessionService from '../session/session.service';
import * as circleService from '../circle/circle.service';
import * as emailService from '../email/email.service';
import config from '../../config';

// Generate URL-safe invite codes (12 chars, alphanumeric — higher entropy for brute-force resistance)
export const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 12);

const INVITE_COLUMNS = `
  id, code, type, inviter_id AS "inviterId", invitee_email AS "inviteeEmail",
  pod_id AS "podId", session_id AS "sessionId", circle_id AS "circleId", status, max_uses AS "maxUses",
  use_count AS "useCount", expires_at AS "expiresAt",
  accepted_by_user_id AS "acceptedByUserId", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

// ─── Create Invite ──────────────────────────────────────────────────────────

/** Admins and super admins may invite to anything. */
export function isAdminRole(userRole?: string): boolean {
  return userRole === 'admin' || userRole === 'super_admin';
}

/**
 * How many invites a member may still send today: their daily entitlement (100 unless set) against the pending
 * invites they sent in the last day. Admins are exempt, so callers skip this for them.
 */
export async function dailyInviteAllowance(userId: string): Promise<{ maxPerDay: number; sentToday: number }> {
  const entResult = await query<{ max_invites_per_day: number }>(
    `SELECT max_invites_per_day FROM user_entitlements WHERE user_id = $1`,
    [userId]
  );
  const maxPerDay = entResult.rows[0]?.max_invites_per_day ?? 100; // default 100/day
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM invites WHERE inviter_id = $1 AND created_at > NOW() - INTERVAL '1 day' AND status = 'pending'`,
    [userId]
  );
  return { maxPerDay, sentToday: parseInt(countResult.rows[0].count, 10) };
}

export function inviteLimitError(maxPerDay: number): AppError {
  return new AppError(429, 'INVITE_LIMIT_REACHED', `You can send up to ${maxPerDay} invites per day. Try again tomorrow.`);
}

/**
 * Who may send invites to a pod: an admin, the pod's director or host, or an active member when the pod allows
 * member invites. Returns the pod. createInvite, the candidates list and the batch all ask this, so the three can
 * never disagree about who may invite (26 Oct 2026).
 */
export async function assertMayInviteToPod(podId: string, userId: string, isAdmin: boolean) {
  const pod = await podService.getPodById(podId);

  // Cannot invite to archived pods
  if (pod.status === 'archived') {
    throw new AppError(400, 'POD_ARCHIVED', 'Cannot invite to an archived pod');
  }

  // Directors and hosts can always invite; regular members can only invite if pod allows it
  if (!isAdmin) {
    const memberRole = await podService.getMemberRole(podId, userId);
    const isDirectorOrHost = memberRole === 'director' || memberRole === 'host';
    if (!isDirectorOrHost) {
      // Check if pod allows member invites AND sender is an active member
      if (!pod.allowMemberInvites) {
        throw new AppError(403, 'AUTH_FORBIDDEN', 'Only pod directors and hosts can send pod invites');
      }
      if (!memberRole || memberRole !== 'member') {
        throw new AppError(403, 'AUTH_FORBIDDEN', 'You must be a pod member to send invites');
      }
    }
  }
  return pod;
}

/**
 * Who may send invites to an event: an admin, its host, or a co-host. Returns the event. 26 Oct 2026: a co-host
 * was already shown whom to invite (GET /pods/:id/members/for-invite) and then refused when they sent it; only
 * the host could. The co-host is read from session_cohosts, the one place a co-host is recorded.
 */
export async function assertMayInviteToSession(sessionId: string, userId: string, isAdmin: boolean): Promise<Session> {
  const session = await sessionService.getSessionById(sessionId);

  // Cannot invite to completed or cancelled events
  if (session.status === 'completed' || session.status === 'cancelled') {
    throw new AppError(400, 'VALIDATION_ERROR', `Cannot invite to a ${session.status} event`);
  }

  if (!isAdmin && session.hostUserId !== userId) {
    const cohost = await query(
      `SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
      [sessionId, userId]
    );
    if (cohost.rows.length === 0) {
      throw new AppError(403, 'AUTH_FORBIDDEN', 'Only the event host or a co-host can send event invites');
    }
  }
  return session;
}

/**
 * How a person runs an event's invites (reads the list, reminds, withdraws anybody's): as an admin, as the event's
 * host, or as a co-host (any session_cohosts row, either role). null when they do not. The same people who may send
 * the event's invites (assertMayInviteToSession), so nobody can send an invite they cannot then manage.
 */
export async function eventInviteRole(
  sessionId: string,
  userId: string,
  isAdmin: boolean,
): Promise<'admin' | 'host' | 'cohost' | null> {
  if (isAdmin) return 'admin';
  const result = await query<{ is_host: boolean | null; is_cohost: boolean }>(
    `SELECT (s.host_user_id = $2) AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost
       FROM sessions s WHERE s.id = $1`,
    [sessionId, userId]
  );
  const relation = result.rows[0];
  if (!relation) return null;
  if (relation.is_host === true) return 'host';
  return relation.is_cohost ? 'cohost' : null;
}

/** A pod's invites are run by its director, its host and admins: the people who can list and remind them. */
export async function mayRunPodInvites(podId: string, userId: string, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const role = await podService.getMemberRole(podId, userId);
  return role === 'director' || role === 'host';
}

/**
 * Whether this person runs the one target an invite is for: an event invite's event (its host or a co-host), a pod
 * invite's pod (its director or host). A platform or circle invite has no one who runs it. The invite's TYPE decides, not
 * whichever id happens to be set (fix round 3): an old event invite that carries a stray pod id is the event's alone,
 * and an old pod invite that carries a stray event id is the pod's, so that event's host has no hold on it. Admins are
 * settled by the callers, which skip the lookup for them.
 */
async function runsTheTargetOf(invite: { type: string; session_id: string | null; pod_id: string | null }, userId: string): Promise<boolean> {
  if (invite.type === InviteType.SESSION && invite.session_id !== null) return (await eventInviteRole(invite.session_id, userId, false)) !== null;
  if (invite.type === InviteType.POD && invite.pod_id !== null) return mayRunPodInvites(invite.pod_id, userId, false);
  return false;
}

/**
 * Which of these addresses must not be invited or emailed by this sender: the address of an account that is closed,
 * suspended or banned, or of a member who blocked the sender or whom the sender blocked. Addresses of people who are
 * not members are fine. Nothing here says which reason applied, so a block is never revealed (fix round 1).
 */
export async function unreachableAddresses(senderId: string, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const result = await query<{ email: string }>(
    `SELECT u.email FROM users u
      WHERE u.email = ANY($2::text[])
        AND (u.status <> 'active'
             OR EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                            OR (b.blocker_id = u.id AND b.blocked_id = $1)))`,
    [senderId, emails.map((email) => email.toLowerCase())]
  );
  return new Set(result.rows.map((row) => row.email.toLowerCase()));
}

/** The one sentence for every person who cannot be invited, whatever the reason. */
export const CANNOT_BE_INVITED = "This person can't be invited.";

/** One new pending invite, as it is stored. */
export interface NewInvite {
  code: string;
  type: InviteType;
  inviterId: string;
  inviteeEmail: string | null;
  podId: string | null;
  sessionId: string | null;
  circleId: string | null;
  maxUses: number;
  expiresAt: Date | null;
}

export type InsertedInvite =
  | { duplicate: false; invite: Invite }
  | { duplicate: true; existingId: string };

// A pending invite that has expired no longer counts: it can never be accepted, and it must not stop a fresh
// invite to the same person (26 Oct 2026).
const PENDING_DUPLICATE_SQL = `
  SELECT id FROM invites
  WHERE invitee_email = $1 AND type = $2 AND status = 'pending'
    AND (expires_at IS NULL OR expires_at > NOW())
    AND ($3::uuid IS NULL OR pod_id = $3)
    AND ($4::uuid IS NULL OR session_id = $4)
    AND ($5::uuid IS NULL OR circle_id = $5)`;

const INSERT_INVITE_SQL = `
  INSERT INTO invites (code, type, inviter_id, invitee_email, pod_id, session_id, max_uses, expires_at, circle_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING ${INVITE_COLUMNS}`;

/**
 * Inserts an invite unless the same person already has a live pending one for the same target.
 *
 * The check and the insert used to be two separate statements, so a double click or two tabs could both pass the
 * check and make two invites (audit 03, defect 11). They now run in one short transaction behind
 * pg_advisory_xact_lock on type, target and address: a second request for that person waits for the first to
 * commit, then finds its invite. No unique index is added (it could fail on duplicates already in the table), and
 * the lock is released at commit, so it works through Neon's pooler. An open link names nobody, so it has no
 * duplicate to guard against and is inserted at once.
 */
export async function insertPendingInvite(row: NewInvite): Promise<InsertedInvite> {
  // Only the target that belongs to the invite's type counts: for the lock, for the duplicate check (fix round 1) and
  // for the row itself (fix round 2). An event invite posted with a stray podId is the event's invite, shares the
  // event's lock, and must not hang on a pod: the pod's director would run it, because withdrawing and reminding
  // follow the ids a row carries.
  const podId = row.type === InviteType.POD ? row.podId : null;
  const sessionId = row.type === InviteType.SESSION ? row.sessionId : null;
  const circleId = row.type === InviteType.CIRCLE ? row.circleId : null;
  const values = [
    row.code, row.type, row.inviterId, row.inviteeEmail, podId, sessionId, row.maxUses, row.expiresAt, circleId,
  ];
  if (!row.inviteeEmail) {
    const inserted = await query<Invite>(INSERT_INVITE_SQL, values);
    return { duplicate: false, invite: inserted.rows[0] };
  }
  const email = row.inviteeEmail;
  const target = podId ?? sessionId ?? circleId ?? '';
  return transaction<InsertedInvite>(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${row.type}:${target}:${email}`]);
    const existing = await client.query<{ id: string }>(
      PENDING_DUPLICATE_SQL,
      [email, row.type, podId, sessionId, circleId]
    );
    if (existing.rows.length > 0) return { duplicate: true, existingId: existing.rows[0].id };
    const inserted = await client.query<Invite>(INSERT_INVITE_SQL, values);
    return { duplicate: false, invite: inserted.rows[0] };
  });
}

type InviteCalendarEvent = NonNullable<Parameters<typeof emailService.sendInviteEmail>[1]['calendarEvent']>;

/** What one invite's email and bell say about the pod, circle or event: looked up once, so a batch asks once. */
export interface InviteContext {
  type: InviteType | undefined;
  podId: string | null;
  sessionId: string | null;
  inviterName: string;
  targetName?: string;
  calendarEvent?: InviteCalendarEvent;
  /** When the event starts (ISO), for the bell; null for a pod, a circle or an unscheduled event. */
  scheduledAt: string | null;
}

export async function buildInviteContext(
  inviterId: string,
  type: InviteType | undefined,
  target: { podId?: string | null; sessionId?: string | null; circleId?: string | null },
): Promise<InviteContext> {
  const inviterResult = await query<{ displayName: string }>(
    `SELECT display_name AS "displayName" FROM users WHERE id = $1`,
    [inviterId]
  );
  const inviterName = inviterResult.rows[0]?.displayName || 'Someone';

  let targetName: string | undefined;
  if (type === InviteType.POD && target.podId) {
    const podResult = await query<{ name: string }>('SELECT name FROM pods WHERE id = $1', [target.podId]);
    targetName = podResult.rows[0]?.name;
  }
  if (type === InviteType.CIRCLE && target.circleId) {
    // Archived circles are not invitable, so their name does not belong in an
    // invite email either (22 Sep 2026).
    const circleResult = await query<{ name: string }>(
      'SELECT name FROM circles WHERE id = $1 AND archived_at IS NULL', [target.circleId]);
    targetName = circleResult.rows[0]?.name;
  }
  let calendarEvent: InviteCalendarEvent | undefined = undefined;
  let scheduledAt: string | null = null;
  if (type === InviteType.SESSION && target.sessionId) {
    const sessionResult = await query<{ title: string; scheduled_at: string | null; host_user_id: string; config: Record<string, unknown>; event_format?: string | null }>(
      'SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions WHERE id = $1', [target.sessionId]
    );
    const session = sessionResult.rows[0];
    targetName = session?.title;
    scheduledAt = session?.scheduled_at ?? null;

    // Build calendar event data if session has a scheduled time
    if (session?.scheduled_at) {
      // 26 Oct 2026 — the event's own length: a meeting's, or the rounds estimate (eventDurationMinutes).
      const totalMinutes = eventDurationMinutes(resolveEventFormat({ format: session.event_format, config: session.config }), session.config);

      // Get host email for organizer
      const hostResult = await query<{ display_name: string; email: string }>(
        'SELECT display_name, email FROM users WHERE id = $1', [session.host_user_id]
      );
      const host = hostResult.rows[0];

      calendarEvent = {
        title: session.title,
        description: `REASON event — ${session.title}`,
        startTime: new Date(session.scheduled_at),
        durationMinutes: totalMinutes,
        organizerName: host?.display_name || 'REASON',
        organizerEmail: host?.email,
        sessionId: target.sessionId,
      };
    }
  }
  return {
    type, podId: target.podId ?? null, sessionId: target.sessionId ?? null, inviterName, targetName, calendarEvent, scheduledAt,
  };
}

/** The two ways an invite is delivered, and who it is for: `inviteeUserId` is passed when the caller already knows who the address belongs to. */
interface InviteDelivery {
  code: string;
  inviteeEmail: string;
  inviteeUserId?: string;
}

/**
 * The invitation email. A failure comes out to the caller, who decides what it costs: the invite exists whatever
 * happens to its email. It touches nothing but the mail provider (no database, no socket), so a batch can send
 * its emails after answering, slowly, without a request still open.
 */
export async function emailInvite(ctx: InviteContext, invite: InviteDelivery): Promise<void> {
  await emailService.sendInviteEmail(invite.inviteeEmail, {
    inviterName: ctx.inviterName,
    type: (ctx.type || 'platform') as 'pod' | 'session' | 'platform' | 'circle',
    targetName: ctx.targetName,
    inviteUrl: `${config.clientUrl}/invite/${invite.code}`,
    calendarEvent: ctx.calendarEvent,
  });
}

/**
 * Whether an invite waiting for its email should still be emailed: it is still pending and has time left, and its
 * address is one the sender may still email (no block either way since, the account not closed). A batch sends its
 * emails up to half a minute after it made the invites, so each is read again just before it goes (fix round 2). That
 * is two statements: the invite, then unreachableAddresses, the block and closed-account question that createInvite and
 * the reminders ask. A question that could not be answered comes out as the error, for the caller to treat as "not safe
 * to send".
 */
export async function isStillEmailable(inviteId: string, senderId: string): Promise<boolean> {
  const found = await query<{ invitee_email: string | null }>(
    `SELECT invitee_email FROM invites WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())`,
    [inviteId]
  );
  const address = found.rows[0]?.invitee_email;
  if (!address) return false;
  return (await unreachableAddresses(senderId, [address])).size === 0;
}

/**
 * The email and then, when the invitee is already a member, the bell. Never throws for an email problem: the invite
 * exists whatever happens here, and the failure is logged.
 */
export async function deliverInvite(ctx: InviteContext, invite: InviteDelivery): Promise<void> {
  // Await email send — if it fails, the invite still exists in DB but we log the failure.
  // Previously fire-and-forget caused silent delivery failures.
  try {
    await emailInvite(ctx, invite);
  } catch (err) {
    // Don't fail the invite creation — email is best-effort but now properly logged
    logger.warn({ err, inviteeEmail: invite.inviteeEmail }, 'Failed to send invite email (invite still created)');
  }

  await notifyInvitee(ctx, invite);
}

/**
 * The invitee's bell, when they are already a member: a notification row, the live push, and their lists told.
 * `inviteeUserId` saves the lookup by address when the caller knows who it is (a batch picks members by id).
 */
export async function notifyInvitee(ctx: InviteContext, invite: InviteDelivery): Promise<void> {
  const { inviterName, targetName, type } = ctx;

  // Create in-app notification for existing users
  let inviteeId = invite.inviteeUserId;
  if (!inviteeId) {
    const inviteeUser = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [invite.inviteeEmail.toLowerCase()]);
    inviteeId = inviteeUser.rows[0]?.id;
  }
  if (!inviteeId) return;

  const notifType = type === InviteType.POD ? 'pod_invite'
    : type === InviteType.CIRCLE ? 'circle_invite' : 'event_invite';
  const notifTitle = type === InviteType.POD
    ? `${inviterName} invited you to ${targetName || 'a pod'}`
    : type === InviteType.CIRCLE
      ? `${inviterName} invited you to ${targetName || 'a circle'}`
      : `${inviterName} invited you to ${targetName || 'an event'}`;
  const notifLink = `/invite/${invite.code}`;
  // Build a richer body with event details when available
  let notifBody = `Invite from ${inviterName}`;
  if (type === InviteType.SESSION && ctx.sessionId) {
    if (ctx.scheduledAt) {
      const d = new Date(ctx.scheduledAt);
      notifBody = `${targetName || 'Event'} · ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }
  } else if (type === InviteType.POD) {
    notifBody = `Join ${targetName || 'this pod'} — invited by ${inviterName}`;
  }
  const notifResult = await query<{ id: string; created_at: string }>(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [inviteeId, notifType, notifTitle, notifBody, notifLink]
  ).catch(err => { logger.warn({ err }, 'Failed to create notification (non-fatal)'); return null; });

  // Push real-time notification via socket so bell icon updates instantly
  if (notifResult && notifResult.rows.length > 0) {
    try {
      const { io } = await import('../../index');
      io.to(`user:${inviteeId}`).emit('notification:new', {
        id: notifResult.rows[0].id,
        type: notifType,
        title: notifTitle,
        body: notifBody,
        link: notifLink,
        isRead: false,
        createdAt: notifResult.rows[0].created_at,
        inviteStatus: 'pending',
        podId: ctx.podId,
        sessionId: ctx.sessionId,
      });
      // Phase 2 dual-emit — invitee's bell + received-invites surfaces
      // refresh in the same tick as the bespoke event.
      const { emitEntities } = await import('../../realtime/emit');
      const { E } = await import('../../realtime/entities');
      emitEntities(
        io, [inviteeId],
        [E.userNotifications(inviteeId), E.userInvites(inviteeId)],
      ).catch(() => {});
    } catch { /* socket push is non-fatal */ }
  }
}

export async function createInvite(userId: string, input: CreateInviteInput, userRole?: string): Promise<Invite> {
  const code = generateCode();

  // 9 Sep 2026: member lists no longer carry emails, so a pick from a list
  // arrives as inviteeUserId — resolve the address here, before any check.
  if (!input.inviteeEmail && input.inviteeUserId) {
    const target = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [input.inviteeUserId]);
    if (!target.rows[0]) throw new NotFoundError('User', input.inviteeUserId);
    input = { ...input, inviteeEmail: target.rows[0].email };
  }

  let expiresAt: Date | null = null;
  if (input.expiresInHours) {
    expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
  }

  const isAdmin = isAdminRole(userRole);

  // ─── Entitlements: enforce max_invites_per_day ──────────────────────────
  if (!isAdmin) {
    const { maxPerDay, sentToday } = await dailyInviteAllowance(userId);
    if (sentToday >= maxPerDay) throw inviteLimitError(maxPerDay);
  }

  // Block self-invites
  if (input.inviteeEmail) {
    const callerResult = await query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    if (callerResult.rows[0]?.email === input.inviteeEmail.toLowerCase()) {
      throw new AppError(400, 'SELF_INVITE', 'You cannot invite yourself');
    }
  }

  // 13 Aug 2026: any member may invite to the platform, with the same effect
  // an admin invite has — Ali's explicit decision, taken over routing member
  // invites through admin approval. Nothing new is added on top: the existing
  // per-member entitlement (max_invites_per_day, default 100) keeps applying
  // exactly as it does to their pod invites, and the audit entry the route
  // writes is what keeps every invite's origin traceable.

  // Platform invites: reject if user is already registered
  if ((!input.type || input.type === InviteType.PLATFORM) && input.inviteeEmail) {
    const existingUser = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [input.inviteeEmail.toLowerCase()]
    );
    if (existingUser.rows.length > 0) {
      throw new AppError(409, 'ALREADY_REGISTERED', 'This user is already registered on the platform');
    }
  }

  // Validate pod/session references — require target for pod/session invites
  // IMPORTANT: membership checks come BEFORE duplicate-invite checks so the
  // user sees "already a member" instead of "pending invite exists"
  // 13 Aug 2026 (C3): circle-level invites, mirroring the pod path. Circles
  // are open-join, so this is a doorway rather than a gate: you must be IN the
  // circle to invite to it, and accepting joins the circle.
  if (input.type === InviteType.CIRCLE) {
    if (!input.circleId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Circle invite requires a circle to be selected');
    }
    const circle = await query<{ id: string }>(
      `SELECT id FROM circles WHERE id = $1 AND archived_at IS NULL`, [input.circleId]);
    if (circle.rows.length === 0) {
      throw new NotFoundError('Circle', input.circleId);
    }
    if (!isAdmin && !(await circleService.isCircleMember(input.circleId, userId))) {
      throw new AppError(403, 'AUTH_FORBIDDEN', 'Only circle members can invite to a circle');
    }
    if (input.inviteeEmail) {
      const existingMember = await query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN circle_members cm ON cm.user_id = u.id
         WHERE u.email = $1 AND cm.circle_id = $2`,
        [input.inviteeEmail.toLowerCase(), input.circleId]
      );
      if (existingMember.rows.length > 0) {
        throw new AppError(409, 'CIRCLE_MEMBER_EXISTS', 'This user is already a member of this circle');
      }
    }
  }

  if (input.type === InviteType.POD) {
    if (!input.podId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Pod invite requires a pod to be selected');
    }
    await assertMayInviteToPod(input.podId, userId, isAdmin);

    // Check if invitee is already a member of this pod
    if (input.inviteeEmail) {
      const existingMember = await query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN pod_members pm ON pm.user_id = u.id
         WHERE u.email = $1 AND pm.pod_id = $2 AND pm.status = 'active'`,
        [input.inviteeEmail.toLowerCase(), input.podId]
      );
      if (existingMember.rows.length > 0) {
        throw new AppError(409, 'POD_MEMBER_EXISTS', 'This user is already a member of this pod');
      }
    }
  }

  if (input.type === InviteType.SESSION) {
    if (!input.sessionId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Event invite requires an event to be selected');
    }
    await assertMayInviteToSession(input.sessionId, userId, isAdmin);

    // Check if invitee is already an ACTIVE participant of this session.
    // #4B (June-10 debrief) — a kicked user (status='removed', or 'left') is NOT
    // an active participant, so the host MUST be able to send them a fresh
    // personal invite to re-admit them. Counting their terminal row here blocked
    // exactly that ("already a participant"), so exclude those statuses.
    if (input.inviteeEmail) {
      const existingParticipant = await query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN session_participants sp ON sp.user_id = u.id
         WHERE u.email = $1 AND sp.session_id = $2 AND sp.status NOT IN ('removed', 'left')`,
        [input.inviteeEmail.toLowerCase(), input.sessionId]
      );
      if (existingParticipant.rows.length > 0) {
        throw new AppError(409, 'SESSION_ALREADY_REGISTERED', 'This user is already a participant of this event');
      }
    }
  }

  // A closed account, or anyone blocked either way with the sender, is never invited or emailed: one neutral
  // sentence for every such case, so a block is never revealed (fix round 1). A platform invite to a registered
  // address is already turned away above, and an open link names nobody.
  if (input.inviteeEmail && input.type && input.type !== InviteType.PLATFORM) {
    const unreachable = await unreachableAddresses(userId, [input.inviteeEmail]);
    if (unreachable.size > 0) throw new AppError(409, 'INVITE_NOT_PERMITTED', CANNOT_BE_INVITED);
  }

  // Block duplicate pending invites (checked AFTER membership so the right error shows). The check and the insert
  // run together, behind a lock for this person and target (see insertPendingInvite).
  const inserted = await insertPendingInvite({
    code,
    type: input.type || InviteType.PLATFORM,
    inviterId: userId,
    inviteeEmail: input.inviteeEmail?.toLowerCase() || null,
    podId: input.podId || null,
    sessionId: input.sessionId || null,
    circleId: input.circleId || null,
    maxUses: input.maxUses || 2,
    expiresAt,
  });
  if (inserted.duplicate) {
    throw new AppError(409, 'DUPLICATE_INVITE', 'A pending invite already exists for this user');
  }

  logger.info({ code, type: input.type, userId }, 'Invite created');

  // Send invite email if a recipient address was provided
  if (input.inviteeEmail) {
    const context = await buildInviteContext(userId, input.type, input);
    await deliverInvite(context, { code, inviteeEmail: input.inviteeEmail });
  }

  return inserted.invite;
}

// ─── Get Invite by Code ─────────────────────────────────────────────────────

export async function getInviteByCode(code: string): Promise<Invite> {
  const result = await query<Invite>(
    `SELECT ${INVITE_COLUMNS} FROM invites WHERE code = $1`,
    [code]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Invite');
  }
  return result.rows[0];
}

// ─── Who reads the address on an invite found by its code ───────────────────
//
// 26 Oct 2026 (fix round 2). GET /invites/:code answers every signed-in caller with the whole invite, and the code is
// all it takes to ask. A co-host (who may not read the others' addresses) was handed the codes of those invites by the
// event's invite list, so the address went to whoever asked. Production's accept page never shows the address, so
// masking it costs nobody anything on screen.

/** The person looking at an invite, as the route knows them. */
export interface InviteViewer {
  userId: string;
  email?: string | null;
  role?: string;
}

/**
 * Whether this person is the host of an event invite's event, or the director or host of a pod invite's pod. A co-host
 * is not one: they read an address on the invites they sent themselves, as in the event's invite list. The invite's
 * TYPE decides which target counts, not whichever id is set (fix round 3): an old pod invite that carries a stray event
 * id is the pod's, an old event invite that carries a stray pod id is the event's. A platform or circle invite has no
 * organiser. Admins are settled by the caller.
 */
async function isOrganiserOf(invite: Pick<Invite, 'type' | 'podId' | 'sessionId'>, userId: string): Promise<boolean> {
  if (invite.type === InviteType.SESSION && invite.sessionId !== null) return (await eventInviteRole(invite.sessionId, userId, false)) === 'host';
  if (invite.type === InviteType.POD && invite.podId !== null) return mayRunPodInvites(invite.podId, userId, false);
  return false;
}

/**
 * The address an invite shows to the person looking at it, whole for the invitee (the address of their account is the
 * invite's), for whoever sent it, for the host of its event or the director or host of its pod, and for admins; masked
 * ("a•••@example.com") for anyone else signed in. An open link has no address and shows none.
 */
export async function inviteeAddressFor(
  invite: Pick<Invite, 'type' | 'inviterId' | 'inviteeEmail' | 'podId' | 'sessionId'>,
  viewer: InviteViewer,
): Promise<string | null> {
  const address = invite.inviteeEmail;
  if (!address) return null;
  if (invite.inviterId === viewer.userId) return address;
  if (viewer.email && sameAddress(address, viewer.email)) return address;
  if (isAdminRole(viewer.role)) return address;
  if (await isOrganiserOf(invite, viewer.userId)) return address;
  return maskEmail(address);
}

// ─── Accept Invite ──────────────────────────────────────────────────────────
//
// Restructured 2026-04-28 into a four-phase pipeline that holds the
// invite-row lock for the minimum time possible. Pre-fix, the entire flow
// (validation + nested service calls + final UPDATE) ran inside a single
// `transaction()` wrapper. The OUTER connection sat idle holding `BEGIN`
// while applyInviteRegistration's NESTED transactions on OTHER pool
// connections did the slow work — and under concurrent accepts (10
// invitees clicking within seconds) the nested calls serialized on
// podService.addMember's `SELECT pods FOR UPDATE`, dragging the outer
// idle window past Neon's idle_in_transaction_session_timeout. Postgres
// killed the connections (FATAL 25P03), the next query on the outer
// client threw "Client has encountered a connection error and is not
// queryable", and the request 500'd after a ~22s hang. From the user
// the symptom was "click does nothing." See incident 2026-04-28 11:00.
//
// Post-fix:
//
//   Phase A — short transaction (~50ms). SELECT FOR UPDATE invite and
//             run all validations (status, expiry, session-ended,
//             identity-match, use-count gate). COMMIT immediately.
//             Lock released. Connection back in the pool. Even under
//             load this never sits idle.
//
//   Phase B — applyInviteRegistration() outside any transaction. Uses
//             pool queries with ON CONFLICT-safe inserts and the
//             ConflictError-swallow pattern, so it's fully idempotent.
//             A retry after a partial failure re-runs cleanly.
//
//   Phase C — atomic UPDATE invites SET use_count = use_count + 1,
//             status = 'accepted', accepted_by/_at = COALESCE(...).
//             The WHERE clause `use_count < max_uses AND status NOT IN
//             ('revoked', 'expired')` is the race guard — it replaces
//             the FOR UPDATE lock for the multi-use case. If a
//             concurrent caller bumped use_count to max between Phase A
//             and Phase C, our UPDATE returns 0 rows and we re-read.
//
//   Phase D — best-effort UPDATE notifications SET is_read = TRUE.
//             Outside any transaction. Failures are non-fatal.
//
// Worst-case race: Phase B succeeds, then Phase C loses the use_count
// race to a concurrent caller. The user is registered (Phase B
// committed) but consumed someone else's slot. Returns success with a
// re-read invite + a logger.warn for visibility. For email-gated
// single-use invites (RSN's actual production usage) this is impossible
// because the identity-match check in Phase A blocks all but the right
// user — only one accept can pass.
//
// Returns AcceptInviteResult so the route can hand the client an explicit
// `redirectTo` instead of guessing.

export interface AcceptInviteResult {
  invite: Invite;
  /** Where the client should navigate next (lobby for session invites, pod page for pod invites). */
  redirectTo: string;
  registeredFor: { sessionId?: string; podId?: string };
  /**
   * Phase 4 (1 May spec) — server-confirmed participant status. Client uses
   * this to know the registration is fully committed before navigating, so
   * the live page never lands with a stale "not registered" cache. Absent
   * for pod-only invites.
   */
  participantStatus?: string;
}

async function applyInviteRegistration(
  invite: Invite,
  userId: string,
): Promise<{ sessionId?: string; podId?: string; circleId?: string }> {
  const out: { sessionId?: string; podId?: string; circleId?: string } = {};

  // 13 Aug 2026 (C3): a circle invite joins the circle. joinCircle is
  // idempotent (ON CONFLICT DO NOTHING, counter moves only on a real insert).
  if (invite.type === InviteType.CIRCLE && invite.circleId) {
    await circleService.joinCircle(invite.circleId, userId);
    out.circleId = invite.circleId;
  }

  if (invite.type === InviteType.POD && invite.podId) {
    try {
      await podService.addMember(invite.podId, userId);
    } catch (err) {
      // Already a member — that's fine, the invite still resolves to "you're in".
      if (!(err instanceof ConflictError)) throw err;
    }
    out.podId = invite.podId;
  }

  if (invite.type === InviteType.SESSION && invite.sessionId) {
    // Add to pod FIRST so registerParticipant doesn't reject for private pods
    const sessionRow = await query<{ podId: string }>(
      `SELECT pod_id AS "podId" FROM sessions WHERE id = $1`,
      [invite.sessionId],
    );
    const podId = sessionRow.rows[0]?.podId;
    if (podId) {
      try {
        await podService.addMember(podId, userId);
      } catch (err) {
        // Already a member is fine — the invite still resolves to "you're in".
        // #4B — swallow by error CODE as well as instanceof: addMember throws its
        // ConflictError from inside its own transaction, and the instanceof check
        // proved unreliable across that boundary (a re-invited but still-pod-member
        // kicked user hit POD_MEMBER_EXISTS here, blocking the re-admit below).
        const code = (err as { code?: string } | undefined)?.code;
        if (!(err instanceof ConflictError) && code !== 'POD_MEMBER_EXISTS' && code !== 'POD_FULL') throw err;
      }
      out.podId = podId;
    }

    // #4B (June-10 debrief) — a fresh PERSONAL invite (targeted email) is the
    // host's way to re-admit a kicked user, so it lifts the removed-bar. A
    // shareable/multi-use link (no inviteeEmail) must NOT silently re-admit a
    // removed user — they stay bounced until personally re-invited.
    const allowRemovedReadmit = !!invite.inviteeEmail;
    try {
      await sessionService.registerParticipant(invite.sessionId, userId, undefined, { allowRemovedReadmit });
    } catch (err) {
      if (err instanceof ConflictError) {
        // Already registered — fine, idempotent.
      } else {
        // Capacity, status, or other validation error — bubble up so the
        // tx rolls back and the user gets a definitive error.
        throw err;
      }
    }

    // Defensive idempotent INSERT to handle the rare case where
    // registerParticipant returned successfully but the row was wiped by
    // a parallel removal. ON CONFLICT preserves invariant.
    // H1 fix round 1 — a row a kick has just made 'removed' is lifted only by a
    // personal invite; a shared link leaves it removed (a removal is terminal).
    await query(
      allowRemovedReadmit
        ? `INSERT INTO session_participants (session_id, user_id, status)
           VALUES ($1, $2, 'registered')
           ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'registered', left_at = NULL
           WHERE session_participants.status = 'removed'`
        : `INSERT INTO session_participants (session_id, user_id, status)
           VALUES ($1, $2, 'registered')
           ON CONFLICT (session_id, user_id) DO NOTHING`,
      [invite.sessionId, userId],
    );

    out.sessionId = invite.sessionId;
  }

  return out;
}

function computeRedirectTo(_invite: Invite, registered: { sessionId?: string; podId?: string; circleId?: string }): string {
  // #1 (June-10 debrief) — a SESSION invite lands on the event DETAILS page
  // (`/sessions/:sessionId`, see client/src/App.tsx), NOT straight into the live
  // room. The details page shows event info + an explicit "Enter Event" button;
  // camera/mic are only acquired once the user clicks through to `/session/:id/
  // live`. Pod invite → the pod page.
  if (registered.sessionId) return `/sessions/${registered.sessionId}`;
  if (registered.podId) return `/pods/${registered.podId}`;
  if (registered.circleId) return `/circles/${registered.circleId}`;
  // Fallback for malformed invites (no podId or sessionId attached) — never
  // hit in practice, present for type completeness.
  return '/dashboard';
}

/** Whether two addresses are the same one: trimmed and lower-cased, as acceptInvite has always compared them. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * What a person signed in as another account than the invited one is told. The accept page shows it as it is, so it
 * still says whom the invite is for, but with the address masked: whole, it gave the address to anybody signed in who
 * had the code (fix round 2, the same hole as GET /invites/:code through the other door).
 */
function identityMismatchMessage(inviteeEmail: string, userEmail?: string): string {
  const signedInAs = userEmail ? `, but you're logged in as ${userEmail}` : '';
  return `This invite was sent to ${maskEmail(inviteeEmail)}${signedInAs}. Sign in to the right account to accept.`;
}

export async function acceptInvite(
  code: string,
  userId: string,
  userEmail?: string,
): Promise<AcceptInviteResult> {
  // ── Phase A — short transaction. Lock invite, run all validations,
  //     COMMIT. The connection is back in the pool before any slow work,
  //     so it can never sit idle past Neon's idle-in-transaction timeout.
  const phaseA = await transaction(async (client) => {
    const inviteResult = await client.query(
      `SELECT ${INVITE_COLUMNS} FROM invites WHERE code = $1 FOR UPDATE`,
      [code]
    );

    if (inviteResult.rows.length === 0) {
      throw new NotFoundError('Invite');
    }

    const invite = inviteResult.rows[0] as Invite;

    if (invite.status === InviteStatus.REVOKED) {
      throw new AppError(400, 'INVITE_REVOKED', 'This invite has been revoked');
    }

    if (invite.status === InviteStatus.EXPIRED) {
      throw new AppError(400, 'INVITE_EXPIRED', 'This invite has expired');
    }

    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      await client.query(
        `UPDATE invites SET status = 'expired' WHERE id = $1`,
        [invite.id]
      );
      throw new AppError(400, 'INVITE_EXPIRED', 'This invite has expired');
    }

    if (invite.type === InviteType.SESSION && invite.sessionId) {
      const sessionResult = await client.query(
        `SELECT status FROM sessions WHERE id = $1`,
        [invite.sessionId]
      );
      const sessionStatus = sessionResult.rows[0]?.status;
      if (sessionStatus === 'completed' || sessionStatus === 'cancelled') {
        throw new AppError(400, 'EVENT_ENDED', 'This event has already ended');
      }
    }

    // T1-1 identity-match guard. If the invite was issued to a specific
    // email AND the authenticated user's email is known AND they don't
    // match (case-insensitive), reject. The userEmail param is optional
    // so legacy callers and code-only invites (no invitee_email) keep
    // working unchanged.
    if (invite.inviteeEmail && userEmail) {
      const inviteEmailNorm = invite.inviteeEmail.trim().toLowerCase();
      const userEmailNorm = userEmail.trim().toLowerCase();
      if (inviteEmailNorm !== userEmailNorm) {
        throw new AppError(
          403,
          'IDENTITY_MISMATCH',
          identityMismatchMessage(invite.inviteeEmail, userEmail),
        );
      }
    }

    // Use-count gate. Same user re-clicking maxed invite → Invite
    // re-acceptance, marker propagates to Phase B/C. Different user
    // exhausting it → reject.
    let isIdempotent = false;
    if (invite.useCount >= invite.maxUses) {
      if (invite.acceptedByUserId === userId) {
        isIdempotent = true;
      } else {
        throw new AppError(400, 'INVITE_ALREADY_USED', 'This invite has reached its maximum uses');
      }
    }

    return { invite, isIdempotent };
  });
  // Phase A committed. Lock released. Connection returned to pool.

  const { invite, isIdempotent } = phaseA;

  // ── Phase B — apply registration outside any transaction. Uses pool
  //     queries with ON CONFLICT and ConflictError-swallow → fully
  //     idempotent. If this throws, Phase C never runs and the user can
  //     retry cleanly. If a partial failure leaves pod_member committed
  //     but session_participant missing, the next retry's Phase B
  //     re-runs idempotently.
  const registered = await applyInviteRegistration(invite, userId);

  // Idempotent re-acceptance path: registration re-applied, no use_count
  // bump, no further DB writes needed.
  if (isIdempotent) {
    logger.info({ code, userId, type: invite.type }, 'Invite re-acceptance — effects re-applied');
    // Phase 4 (1 May spec) — read back participant status for idempotent path too.
    // Phase 8A.1 (8 May spec) — Stefan #1: default to 'registered' when the
    // SELECT misses (the row exists conceptually since applyInviteRegistration
    // already ran above, but a transactional read window can return 0 rows).
    // Pre-fix the undefined value made the client think the server failed
    // and surface the false-negative "Failed to accept invite" toast.
    let participantStatusIdempotent: string | undefined;
    if (registered.sessionId) {
      const sr = await query<{ status: string }>(
        `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
        [registered.sessionId, userId],
      );
      participantStatusIdempotent = sr.rows[0]?.status ?? 'registered';
    }
    return {
      invite,
      redirectTo: computeRedirectTo(invite, registered),
      registeredFor: registered,
      participantStatus: participantStatusIdempotent,
    };
  }

  // ── Phase C — atomic UPDATE invites SET use_count. The WHERE clause
  //     is the race guard: a concurrent caller that bumped use_count to
  //     max between Phase A and here causes our UPDATE to return 0 rows.
  const updateResult = await query<Invite>(
    `UPDATE invites
       SET use_count = use_count + 1,
           status = 'accepted'::invite_status,
           accepted_by_user_id = COALESCE(accepted_by_user_id, $1),
           accepted_at = COALESCE(accepted_at, NOW())
     WHERE id = $2
       AND use_count < max_uses
       AND status NOT IN ('revoked'::invite_status, 'expired'::invite_status)
     RETURNING ${INVITE_COLUMNS}`,
    [userId, invite.id]
  );

  let finalInvite: Invite;
  if (updateResult.rowCount === 0) {
    // Lost the use_count race or the invite was revoked/expired between
    // Phase A and Phase C. Phase B already registered the user
    // idempotently, so we still return success — they have what they
    // wanted. Re-read invite for the response.
    const reread = await query<Invite>(
      `SELECT ${INVITE_COLUMNS} FROM invites WHERE id = $1`,
      [invite.id]
    );
    finalInvite = reread.rows[0] as Invite;
    logger.warn(
      { code, userId, type: invite.type },
      'Invite use_count race lost during accept; user registered anyway',
    );
  } else {
    finalInvite = updateResult.rows[0] as Invite;
  }

  // ── Phase D — best-effort notification sync. Outside any transaction.
  try {
    await query(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND link LIKE $2 AND is_read = FALSE`,
      [userId, `%${code}%`]
    );
  } catch { /* non-fatal */ }

  logger.info({ code, userId, type: invite.type }, 'Invite accepted');

  // Phase 4 (1 May spec) — read back participant status so client can
  // confirm registration is fully committed before navigating to the live
  // page. Eliminates the post-redirect 404 race Stefan reported.
  let participantStatus: string | undefined;
  if (registered.sessionId) {
    const statusRes = await query<{ status: string }>(
      `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [registered.sessionId, userId],
    );
    participantStatus = statusRes.rows[0]?.status;
  }

  return {
    invite: finalInvite,
    redirectTo: computeRedirectTo(invite, registered),
    registeredFor: registered,
    participantStatus,
  };
}

// ─── Mark an Invite Accepted ────────────────────────────────────────────────
//
// 26 Oct 2026 (fix round 2). The route behind this ("force-mark an invite accepted for the current user", from the days
// the client recovered a failed accept with it) checked neither who was asking nor what state the invite was in.
// Anyone signed in who knew a code could turn a withdrawn or declined invite back into an accepted one, which
// acceptInvite then admits again, and replace the record of who accepted it. Nothing in the client has called it since
// T0-4 removed that recovery chain, so it now applies the rules acceptInvite applies, in its order, and none stricter
// but one: the invite must still be usable (not withdrawn, not expired, its event not over: fix round 3 added that last
// check, which round 2 had left out), and a personal invite is marked only for the person it was sent to. The one place
// it is stricter is a caller whose own address is unknown, whom accept lets through for legacy callers.
export async function markInviteAccepted(
  code: string,
  userId: string,
  userEmail?: string,
): Promise<{ podId: string | null; sessionId: string | null }> {
  return transaction(async (client) => {
    const found = await client.query(`SELECT ${INVITE_COLUMNS} FROM invites WHERE code = $1 FOR UPDATE`, [code]);
    if (found.rows.length === 0) throw new NotFoundError('Invite');
    const invite = found.rows[0] as Invite;

    if (invite.status === InviteStatus.REVOKED) {
      throw new AppError(400, 'INVITE_REVOKED', 'This invite has been revoked');
    }
    if (invite.status === InviteStatus.EXPIRED || (invite.expiresAt && new Date(invite.expiresAt) < new Date())) {
      throw new AppError(400, 'INVITE_EXPIRED', 'This invite has expired');
    }
    // An invite to an event that has ended is refused, as accept refuses it (fix round 3; round 2 left it out): after the
    // invite's own state and before the identity check, in accept's order.
    if (invite.type === InviteType.SESSION && invite.sessionId) {
      const sessionResult = await client.query(`SELECT status FROM sessions WHERE id = $1`, [invite.sessionId]);
      const sessionStatus = sessionResult.rows[0]?.status;
      if (sessionStatus === 'completed' || sessionStatus === 'cancelled') {
        throw new AppError(400, 'EVENT_ENDED', 'This event has already ended');
      }
    }
    // A personal invite is for the address it was sent to. acceptInvite lets a caller whose address is unknown through
    // (legacy callers); this does not: no one relies on this path, and it is not worth a way round.
    if (invite.inviteeEmail && !(userEmail && sameAddress(invite.inviteeEmail, userEmail))) {
      throw new AppError(403, 'IDENTITY_MISMATCH', identityMismatchMessage(invite.inviteeEmail, userEmail || undefined));
    }
    if (invite.useCount >= invite.maxUses && invite.acceptedByUserId !== userId) {
      throw new AppError(400, 'INVITE_ALREADY_USED', 'This invite has reached its maximum uses');
    }

    // The first accepter and the first time stay as they were: marking again changes neither.
    await client.query(
      `UPDATE invites SET status = 'accepted', accepted_by_user_id = COALESCE(accepted_by_user_id, $1), accepted_at = COALESCE(accepted_at, NOW()) WHERE id = $2`,
      [userId, invite.id],
    );
    return { podId: invite.podId, sessionId: invite.sessionId };
  });
}

// ─── List Invites ───────────────────────────────────────────────────────────

export async function listInvitesByUser(userId: string, params: {
  type?: InviteType;
  status?: InviteStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ invites: (Invite & { podName?: string; sessionTitle?: string })[]; total: number }> {
  const page = params.page || 1;
  const pageSize = Math.min(params.pageSize || 20, 100);
  const offset = (page - 1) * pageSize;

  let whereClause = 'WHERE i.inviter_id = $1';
  const values: unknown[] = [userId];
  let paramIdx = 2;

  if (params.type) {
    whereClause += ` AND i.type = $${paramIdx}`;
    values.push(params.type);
    paramIdx++;
  }

  if (params.status) {
    whereClause += ` AND i.status = $${paramIdx}`;
    values.push(params.status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM invites i ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Enrich with pod name and session title via LEFT JOIN
  const ENRICHED_COLUMNS = `
    i.id, i.code, i.type, i.inviter_id AS "inviterId", i.invitee_email AS "inviteeEmail",
    i.pod_id AS "podId", i.session_id AS "sessionId", i.status, i.max_uses AS "maxUses",
    i.use_count AS "useCount", i.expires_at AS "expiresAt",
    i.accepted_by_user_id AS "acceptedByUserId", i.accepted_at AS "acceptedAt",
    i.created_at AS "createdAt", i.updated_at AS "updatedAt",
    p.name AS "podName", s.title AS "sessionTitle"
  `;

  values.push(pageSize, offset);
  const result = await query<Invite & { podName?: string; sessionTitle?: string }>(
    `SELECT ${ENRICHED_COLUMNS}
     FROM invites i
     LEFT JOIN pods p ON p.id = i.pod_id
     LEFT JOIN sessions s ON s.id = i.session_id
     ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    values
  );

  return { invites: result.rows, total };
}

// ─── List Received Invites ──────────────────────────────────────────────────

export async function listReceivedInvites(userEmail: string, userId?: string): Promise<(Invite & { podName?: string; sessionTitle?: string; inviterName?: string })[]> {
  const ENRICHED_COLUMNS = `
    i.id, i.code, i.type, i.inviter_id AS "inviterId", i.invitee_email AS "inviteeEmail",
    i.pod_id AS "podId", i.session_id AS "sessionId", i.status, i.max_uses AS "maxUses",
    i.use_count AS "useCount", i.expires_at AS "expiresAt",
    i.accepted_by_user_id AS "acceptedByUserId", i.accepted_at AS "acceptedAt",
    i.created_at AS "createdAt", i.updated_at AS "updatedAt",
    p.name AS "podName", s.title AS "sessionTitle",
    u.display_name AS "inviterName"
  `;

  // Exclude invites already accepted by this user (multi-use invites keep status='pending'
  // after first accept, so we must also filter by accepted_by_user_id).
  // Also exclude invites for sessions/pods the user already joined (covers edge cases
  // where the invite status wasn't updated but the user is already participating).
  const userFilter = userId
    ? `AND (i.accepted_by_user_id IS NULL OR i.accepted_by_user_id != $2)
       AND (i.session_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM session_participants sp
         WHERE sp.session_id = i.session_id AND sp.user_id = $2 AND sp.status != 'removed'
       ))
       AND (i.pod_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM pod_members pm
         WHERE pm.pod_id = i.pod_id AND pm.user_id = $2
           -- Bug 30 (19 May Ali) — only currently-in-pod rows should
           -- mask a new pending invite. A removed/left/declined row is
           -- history and the new invite is legitimately pending.
           AND pm.status NOT IN ('removed', 'left', 'declined')
       ))`
    : '';
  const params = userId
    ? [userEmail.toLowerCase(), userId]
    : [userEmail.toLowerCase()];

  const result = await query<Invite & { podName?: string; sessionTitle?: string; inviterName?: string }>(
    `SELECT ${ENRICHED_COLUMNS}
     FROM invites i
     LEFT JOIN pods p ON p.id = i.pod_id
     LEFT JOIN sessions s ON s.id = i.session_id
     LEFT JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_email = $1 AND i.status = 'pending'
       AND (i.expires_at IS NULL OR i.expires_at > NOW())
       AND (i.session_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM sessions ses WHERE ses.id = i.session_id AND ses.status IN ('completed', 'cancelled')
       ))
       ${userFilter}
     ORDER BY LOWER(i.invitee_email) ASC, i.created_at DESC`,
    params
  );

  return result.rows;
}

// ─── List Session Invites (for host view) ────────────────────────────────────

export interface SessionInviteRow {
  id: string;
  code: string;
  inviteeEmail: string | null;
  inviteeName: string | null;
  /** The member the address belongs to, when it belongs to one (26 Oct 2026). */
  inviteeUserId: string | null;
  /** Who sent it (26 Oct 2026, fix round 1): a co-host sees an address only on the invites they sent themselves. */
  inviterId: string;
  status: string;
  createdAt: string;
  /** When the invitee said no (26 Oct 2026); null for an invite an organiser withdrew. A decline keeps status 'revoked'. */
  declinedAt: string | null;
  /** 18 Sep 2026: an open link (no invitee) is reusable while it has uses
   *  left and has not expired; the live-event invite modal reads these to
   *  reuse one instead of minting a new code on every open. */
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
}

// "Pending" means an invite that can still be accepted. One whose expiry has passed keeps the status 'pending' in
// the table, so a list of the pending ones leaves it out (fix round 1): a person invited again no longer shows twice,
// nobody is reminded with a dead link, and the list agrees with the counts the pod and event pages already show.
const STILL_ACCEPTABLE = 'AND (i.expires_at IS NULL OR i.expires_at > NOW())';

export async function listSessionInvites(
  sessionId: string,
  status?: string
): Promise<SessionInviteRow[]> {
  const statusFilter = status ? `AND i.status = $2` : '';
  const params = status ? [sessionId, status] : [sessionId];

  const result = await query<SessionInviteRow>(
    `SELECT i.id, i.code, i.invitee_email AS "inviteeEmail",
            u.display_name AS "inviteeName", u.id AS "inviteeUserId", i.inviter_id AS "inviterId",
            i.status, i.created_at AS "createdAt", i.declined_at AS "declinedAt",
            i.max_uses AS "maxUses", i.use_count AS "useCount", i.expires_at AS "expiresAt"
     FROM invites i
     LEFT JOIN users u ON u.email = i.invitee_email
     WHERE i.session_id = $1 AND i.type = 'session'
       ${statusFilter}
       ${status === 'pending' ? STILL_ACCEPTABLE : ''}
     ORDER BY i.created_at DESC`,
    params
  );

  return result.rows;
}

/**
 * "a•••@example.com": the first letter of an address and its domain, nothing else. Something that is not an address
 * shows nothing of itself.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/**
 * The event's invites as a co-host may read them: the address on the invites they sent themselves, and on everyone
 * else's a label in its place, because the platform's member lists carry no emails (the host and admins keep every
 * address, as they always had). The label is the member's display name, or for someone who is no member a masked
 * address. It is never empty or null: production's pages treat a falsy inviteeEmail as an open link, and read
 * `inviteeName || inviteeEmail || 'Shareable link'` as the line to show. An open link has no address and stays null.
 *
 * The code goes too (fix round 2). It is all it takes to open the invite, address and all (GET /invites/:code), so a
 * row whose address is hidden must not carry it: it is blank, and nothing on a hidden row can be acted on by code. The
 * pages act by `id` (remind, withdraw) and read `code` only from an open link, which keeps its code.
 */
export function hideOthersAddresses<T extends { code: string; inviteeEmail: string | null; inviteeName: string | null; inviterId: string }>(
  rows: T[],
  viewerId: string,
): T[] {
  return rows.map((row) => {
    if (!row.inviteeEmail || row.inviterId === viewerId) return row;
    return { ...row, inviteeEmail: row.inviteeName || maskEmail(row.inviteeEmail), code: '' };
  });
}

export interface PodInviteRow {
  id: string;
  code: string;
  inviteeEmail: string | null;
  inviteeName: string | null;
  /** The member the address belongs to, when it belongs to one (26 Oct 2026). */
  inviteeUserId: string | null;
  status: string;
  createdAt: string;
  /** When the invitee said no (26 Oct 2026); null for an invite an organiser withdrew. A decline keeps status 'revoked'. */
  declinedAt: string | null;
}

export async function listPodInvites(
  podId: string,
  status?: string
): Promise<PodInviteRow[]> {
  const statusFilter = status ? `AND i.status = $2` : '';
  const params = status ? [podId, status] : [podId];

  const result = await query<PodInviteRow>(
    `SELECT i.id, i.code, i.invitee_email AS "inviteeEmail",
            u.display_name AS "inviteeName", u.id AS "inviteeUserId",
            i.status, i.created_at AS "createdAt", i.declined_at AS "declinedAt"
     FROM invites i
     LEFT JOIN users u ON u.email = i.invitee_email
     WHERE i.pod_id = $1 AND i.type = 'pod'
       ${statusFilter}
       ${status === 'pending' ? STILL_ACCEPTABLE : ''}
     ORDER BY i.created_at DESC`,
    params
  );

  return result.rows;
}

// ─── Decline Invite ─────────────────────────────────────────────────────────

// Bug 30 (19 May Ali) — return the affected invite's podId/sessionId so the
// route can fan out the realtime events without re-querying.
//
// 26 Oct 2026: a decline is stored as 'revoked', the same value an organiser's withdrawal gets, so declined_at
// is what tells them apart. The status stays 'revoked' on purpose: production's bell and Invites page map only
// that value to "Declined".
export async function declineInvite(
  code: string,
  userEmail: string,
): Promise<{ podId: string | null; sessionId: string | null }> {
  const result = await query<{ pod_id: string | null; session_id: string | null }>(
    `UPDATE invites SET status = 'revoked', declined_at = NOW()
     WHERE code = $1 AND invitee_email = $2 AND status = 'pending'
     RETURNING pod_id, session_id`,
    [code, userEmail.toLowerCase()]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Invite');
  }

  // Auto-mark related notifications as read
  try {
    const userResult = await query<{ id: string }>(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [userEmail]);
    if (userResult.rows[0]) {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND link LIKE $2 AND is_read = FALSE`,
        [userResult.rows[0].id, `%${code}%`]
      );
    }
  } catch { /* non-fatal */ }

  logger.info({ code, userEmail }, 'Invite declined by recipient');
  return {
    podId: result.rows[0]?.pod_id ?? null,
    sessionId: result.rows[0]?.session_id ?? null,
  };
}

// ─── Revoke Invite ──────────────────────────────────────────────────────────

// Bug 30 (19 May Ali) — same pattern as declineInvite: return the affected
// IDs so the route can fan out realtime events.
//
// 26 Oct 2026 (fix round 1): the sender could always withdraw their own invite, and only they. Co-hosts may now send
// event invites, so on production's event page the host's Revoke on a co-host's shareable link answered 404 ("Failed
// to revoke invite"). Whoever runs a target's invites can withdraw any of them: for an event its host, its co-hosts
// and admins; for a pod its director, its host and admins (they could already list and remind them). Platform and
// circle invites stay the sender's, and (fix round 2) an admin's, which is the rule for reminding them. Each invite is
// judged by the one target its TYPE names (fix round 3): an event invite by its event, a pod invite by its pod, even
// where an old row also carries the other id. Anyone else is told the invite is not found, as before, so it is not
// confirmed to exist.
//
// Fix round 3: the answer also says who sent the invite and, when its address belongs to a member, which member. A
// withdrawal changes the sender's sent list and the invitee's received list whoever made it, and a platform or circle
// invite has no pod or event whose screens could be told, so the route tells the two people themselves.
export interface RevokedInvite {
  podId: string | null;
  sessionId: string | null;
  inviterId: string;
  /** The member the invite's address belongs to; null when it belongs to no member or the invite is an open link. */
  inviteeUserId: string | null;
}

export async function revokeInvite(
  inviteId: string,
  userId: string,
  userRole?: string,
): Promise<RevokedInvite> {
  const found = await query<{ inviter_id: string; type: string; pod_id: string | null; session_id: string | null; invitee_user_id: string | null }>(
    `SELECT i.inviter_id, i.type, i.pod_id, i.session_id, u.id AS invitee_user_id
       FROM invites i
       LEFT JOIN users u ON u.email = i.invitee_email
      WHERE i.id = $1 AND i.status = 'pending'`,
    [inviteId]
  );
  const invite = found.rows[0];
  if (!invite) throw new NotFoundError('Invite', inviteId);

  const mayWithdraw = invite.inviter_id === userId || isAdminRole(userRole) || (await runsTheTargetOf(invite, userId));
  if (!mayWithdraw) throw new NotFoundError('Invite', inviteId);

  // Only a pending invite is withdrawn: one answered since the check above is simply not found.
  const result = await query<{ pod_id: string | null; session_id: string | null }>(
    `UPDATE invites SET status = 'revoked' WHERE id = $1 AND status = 'pending'
     RETURNING pod_id, session_id`,
    [inviteId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Invite', inviteId);
  }
  logger.info({ inviteId, userId }, 'Invite revoked');
  return {
    podId: result.rows[0]?.pod_id ?? null,
    sessionId: result.rows[0]?.session_id ?? null,
    inviterId: invite.inviter_id,
    inviteeUserId: invite.invitee_user_id,
  };
}
