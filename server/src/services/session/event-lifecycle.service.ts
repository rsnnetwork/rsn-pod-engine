// ─── An event's lifecycle: publish, unpublish, cancel with notice, archive, delete for good (Part 2 Task 2) ──────
//
// D1: the lifecycle sits beside sessions.status. Which steps a person may take is the shared rule
// (allowedLifecycleActions, over eventLifecycleOf); this service holds every step to it, writes the change and its
// audit row in one transaction, and only then tells every screen (fanoutSessionEntities + fanoutSessionListEntities,
// which also reaches the admins' Admin Events list) and the organisers' history (emitEventAuditChanged).
//
// Each step runs under the event's session guard (the one Go Live takes), so a step and a start pressed together run
// one after the other, and reads the event FOR UPDATE, so two instances never both pass the same check. A draft is
// someone else's secret: anyone who does not run it is answered exactly as for an id that does not exist.
//
// Ending stays the live event's own (End Event, the overdue job). Cancelling is for an event that has not started.

import {
  ErrorCodes, UserRole, hasRoleAtLeast, eventLifecycleOf, allowedLifecycleActions,
  type EventLifecycle, type EventLifecycleAction, type EventLifecycleInput, type EventLifecycleWho, type EventPublication,
  type Session,
} from '@rsn/shared';
import type { PoolClient } from 'pg';
import config from '../../config';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { fanoutSessionEntities, fanoutSessionListEntities, resolveSessionListAudience } from '../../realtime/fanout';
import { emitEventAuditChanged, recordEventAudit, type EventAuditAction } from '../audit/event-audit';
import { announceCircleEvent, readEventCircle } from '../circle/circle-events.service';
import * as emailService from '../email/email.service';
import { meetingTime } from '../meetings/meeting-time';
import type { Actor } from '../roles/actor';
import { activeMemberSql } from '../users/active-member';
import { podAdminSql, placesHeldSql, type EventAccessFacts } from './event-access';
import { hardDeleteSession } from './session.service';

/** Every lifecycle state, to ask whether a person could take a step in any of them. */
const ALL_LIFECYCLES: readonly EventLifecycle[] = [
  'draft', 'published', 'registration_open', 'live', 'completed', 'archived', 'cancelled',
];

const NOT_FOUND = "We couldn't find that event.";
export const CANCEL_FALLBACK_BODY = 'The organiser cancelled it.';
export const DELETE_TITLE_MISMATCH = "Type the event's name to delete it.";

// ─── Who may do what (pure) ──────────────────────────────────────────────────

function isPlatformAdmin(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

/** The shared rule's `who`: a platform admin or the pod's admin counts as an admin; a super admin is also named alone. */
export function lifecycleWho(
  facts: { isOwner: boolean; isCohost: boolean; isPodAdmin: boolean },
  role: string | undefined,
): EventLifecycleWho {
  return {
    isOwner: facts.isOwner,
    isCohost: facts.isCohost,
    isAdmin: isPlatformAdmin(role) || facts.isPodAdmin,
    isSuperAdmin: role === UserRole.SUPER_ADMIN,
  };
}

/**
 * The steps this person may take now. The shared rule, with one thing it cannot see from the state alone: a cancelled
 * event that was archived reads 'cancelled' (D1's order), and since it is put away it offers Unarchive, not Archive.
 */
export function eventAllowedActions(
  event: EventLifecycleInput,
  who: EventLifecycleWho,
  registeredCount: number,
  now: Date = new Date(),
): EventLifecycleAction[] {
  const lifecycle = eventLifecycleOf(event, now);
  const actions = allowedLifecycleActions(lifecycle, who, registeredCount);
  if (event.archivedAt === null || lifecycle === 'archived') return actions;
  const unarchive = allowedLifecycleActions('archived', who, registeredCount).filter((a) => a === 'unarchive');
  return [...actions.filter((a) => a !== 'archive'), ...unarchive];
}

/** The lifecycle fields of a Session as eventLifecycleOf reads them; a row from before migration 135 reads published. */
export function lifecycleInputOf(session: Pick<Session, 'status'> & Partial<Pick<Session,
  'publication' | 'archivedAt' | 'registrationOpensAt'>>): EventLifecycleInput {
  return {
    status: session.status,
    publication: session.publication === 'draft' ? 'draft' : 'published',
    archivedAt: session.archivedAt ?? null,
    registrationOpensAt: session.registrationOpensAt ?? null,
  };
}

/** GET /sessions/:id's additive lifecycle block: where the event stands and what this viewer may do about it. */
export function summariseEventLifecycle(
  session: Pick<Session, 'status'> & Partial<Pick<Session, 'publication' | 'archivedAt' | 'registrationOpensAt'>>,
  facts: EventAccessFacts | null,
  role: string | undefined,
  now: Date = new Date(),
): { lifecycle: EventLifecycle; allowedActions: EventLifecycleAction[] } {
  const input = lifecycleInputOf(session);
  const lifecycle = eventLifecycleOf(input, now);
  if (!facts) return { lifecycle, allowedActions: [] };
  const who = lifecycleWho({ isOwner: facts.isHost, isCohost: facts.isCohost, isPodAdmin: facts.isPodAdmin }, role);
  return { lifecycle, allowedActions: eventAllowedActions(input, who, facts.placesHeld, now) };
}

/** Whether this person could take the step in any state: if not, being refused is about who they are, not the event. */
function mayEverTake(action: EventLifecycleAction, who: EventLifecycleWho): boolean {
  return ALL_LIFECYCLES.some((lifecycle) => allowedLifecycleActions(lifecycle, who, 0).includes(action));
}

const FORBIDDEN_SENTENCE: Record<EventLifecycleAction, string> = {
  publish: 'Only the people running this event can publish it.',
  unpublish: 'Only the people running this event can unpublish it.',
  cancel: "Only the event's host or an admin can cancel it.",
  archive: 'Only the people running this event can archive it.',
  unarchive: 'Only the people running this event can unarchive it.',
  delete_permanently: 'Only a super admin can delete an event for good.',
};

/** The refusal for a step the person may take in principle but not in the event's state now. */
function stateRefusal(action: EventLifecycleAction, lifecycle: EventLifecycle, archived: boolean, registeredCount: number): AppError {
  const notAllowed = (message: string) => new ConflictError(ErrorCodes.EVENT_LIFECYCLE_NOT_ALLOWED, message);
  if (lifecycle === 'live' && (action === 'cancel' || action === 'delete_permanently' || action === 'unpublish')) {
    return new ConflictError(
      ErrorCodes.SESSION_IN_PROGRESS,
      action === 'delete_permanently'
        ? 'This event is live. End it from the live event first, then delete it.'
        : 'This event is live. End it from the live event instead.',
    );
  }
  switch (action) {
    case 'publish':
      return notAllowed(lifecycle === 'published' || lifecycle === 'registration_open'
        ? 'This event is already published.' : 'This event can no longer be published.');
    case 'unpublish':
      if ((lifecycle === 'published' || lifecycle === 'registration_open') && registeredCount > 0) {
        return new ConflictError(ErrorCodes.EVENT_HAS_REGISTRATIONS, 'People have already registered. Cancel the event instead.');
      }
      return notAllowed(lifecycle === 'draft' ? 'This event is not published yet.' : 'This event can no longer be unpublished.');
    case 'cancel':
      if (lifecycle === 'cancelled') return new ConflictError(ErrorCodes.EVENT_ALREADY_CANCELLED, 'This event is already cancelled.');
      return notAllowed('This event has already ended.');
    case 'archive':
      return notAllowed(archived ? 'This event is already archived.' : 'Only an event that has ended or was cancelled can be archived.');
    case 'unarchive':
      return notAllowed('This event is not archived.');
    case 'delete_permanently':
      return notAllowed('This event cannot be deleted right now.');
  }
}

// ─── The event, read for a step ──────────────────────────────────────────────

interface LifecycleRow {
  id: string;
  title: string;
  status: string;
  publication: EventPublication;
  archived_at: Date | null;
  registration_opens_at: Date | null;
  scheduled_at: Date | null;
  pod_id: string | null;
  circle_id: string | null;
  is_owner: boolean;
  is_cohost: boolean;
  is_pod_admin: boolean;
  places_held: number;
}

const LIFECYCLE_ROW_SQL = `
  SELECT s.id, s.title, s.status::text AS status, s.publication, s.archived_at, s.registration_opens_at, s.scheduled_at,
         s.pod_id, s.circle_id,
         s.host_user_id = $2 AS is_owner,
         EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
         ${podAdminSql('s', '$2')} AS is_pod_admin,
         ${placesHeldSql('s')} AS places_held
    FROM sessions s
   WHERE s.id = $1
   FOR UPDATE OF s`;

async function readLifecycleRow(client: PoolClient, sessionId: string, userId: string): Promise<LifecycleRow | null> {
  const found = await client.query<LifecycleRow>(LIFECYCLE_ROW_SQL, [sessionId, userId]);
  const row = found.rows[0];
  if (!row) return null;
  return { ...row, is_owner: !!row.is_owner, is_cohost: !!row.is_cohost, is_pod_admin: !!row.is_pod_admin, places_held: Number(row.places_held) || 0 };
}

function inputOfRow(row: LifecycleRow): EventLifecycleInput {
  return {
    status: row.status,
    publication: row.publication === 'draft' ? 'draft' : 'published',
    archivedAt: row.archived_at,
    registrationOpensAt: row.registration_opens_at,
  };
}

/**
 * Holds the step to the rule: an event that does not exist, or a draft the person does not run (its host, a co-host,
 * a platform admin), is 404 with the words an unknown id gets; a person who could never take this step is 403; a step
 * the event's state does not allow is 409 in words.
 */
function assertMayTake(row: LifecycleRow | null, actor: Actor, action: EventLifecycleAction, sessionId: string): LifecycleRow {
  if (!row) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const runs = row.is_owner || row.is_cohost || isPlatformAdmin(actor.role);
  if (row.publication === 'draft' && !runs) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const who = lifecycleWho({ isOwner: row.is_owner, isCohost: row.is_cohost, isPodAdmin: row.is_pod_admin }, actor.role);
  const input = inputOfRow(row);
  if (eventAllowedActions(input, who, row.places_held).includes(action)) return row;
  if (!mayEverTake(action, who)) throw new ForbiddenError(FORBIDDEN_SENTENCE[action]);
  throw stateRefusal(action, eventLifecycleOf(input), row.archived_at !== null, row.places_held);
}

/**
 * One step: under the event's session guard, in one transaction, read the event FOR UPDATE, hold the step to the
 * rule, write it with `write` (which returns false when its guarded UPDATE matched nothing: someone else's step got
 * there first) and its audit row. Returns the row as it was read.
 */
async function takeStep(
  sessionId: string,
  actor: Actor,
  action: EventLifecycleAction,
  auditAction: EventAuditAction,
  write: (client: PoolClient, row: LifecycleRow) => Promise<boolean>,
  reason?: string,
): Promise<LifecycleRow> {
  const { withSessionGuard } = await import('../orchestration/state/session-state');
  const row = await withSessionGuard(sessionId, () => transaction(async (client) => {
    const read = assertMayTake(await readLifecycleRow(client, sessionId, actor.userId), actor, action, sessionId);
    if (!(await write(client, read))) {
      // The guarded UPDATE matched nothing: the event changed after the read (a place taken after it, which the row lock
      // does not hold back, or another step that got there first). Read it again and refuse in the words its state
      // now calls for, so a second cancel hears "already cancelled".
      const now = await readLifecycleRow(client, sessionId, actor.userId);
      if (!now) throw new NotFoundError('Session', sessionId, NOT_FOUND);
      throw stateRefusal(action, eventLifecycleOf(inputOfRow(now)), now.archived_at !== null, now.places_held);
    }
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: auditAction, automatic: false,
      ...(reason ? { reason } : {}),
    }, client);
    return read;
  }));
  logger.info({ sessionId, actorId: actor.userId, action }, 'Event lifecycle step taken');
  return row;
}

/** Tells every screen that shows the event, its lists (members, organisers, admins) and its organisers' history. */
async function tellEveryone(sessionId: string, podId: string | null): Promise<void> {
  await Promise.all([
    fanoutSessionEntities(podId, sessionId),
    fanoutSessionListEntities(podId, sessionId),
    emitEventAuditChanged(sessionId),
  ]);
}

// ─── The steps ───────────────────────────────────────────────────────────────

/** A draft is published: its pod (and its circle, rung now as on create) sees it, and registration opens unless set later. */
export async function publishEvent(sessionId: string, actor: Actor): Promise<void> {
  const row = await takeStep(sessionId, actor, 'publish', 'event.published', async (client) => {
    const updated = await client.query(
      `UPDATE sessions SET publication = 'published', published_at = COALESCE(published_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND publication = 'draft'
        RETURNING id`,
      [sessionId],
    );
    return (updated.rowCount ?? 0) > 0;
  });
  if (row.circle_id) {
    const circle = await readEventCircle(row.circle_id).catch(() => null);
    if (circle) await announceCircleEvent({ sessionId, actorId: actor.userId, circle });
  }
  await tellEveryone(sessionId, row.pod_id);
}

/** A published event nobody has registered for goes back to being a draft. Once anyone holds a place: cancel it instead. */
export async function unpublishEvent(sessionId: string, actor: Actor): Promise<void> {
  const row = await takeStep(sessionId, actor, 'unpublish', 'event.unpublished', async (client) => {
    const updated = await client.query(
      `UPDATE sessions s SET publication = 'draft', updated_at = NOW()
        WHERE s.id = $1 AND s.publication = 'published' AND s.status = 'scheduled' AND s.archived_at IS NULL
          AND ${placesHeldSql('s')} = 0
        RETURNING s.id`,
      [sessionId],
    );
    return (updated.rowCount ?? 0) > 0;
  });
  await tellEveryone(sessionId, row.pod_id);
}

interface CancelRecipient {
  id: string;
  email: string | null;
  timezone: string | null;
  notify_email: boolean | null;
}

/**
 * An event that has not started is cancelled, with the organiser's reason if they gave one. Everyone who held a place
 * (not removed) and every co-host, but the person cancelling, gets one bell, and an email when their email switch and
 * the admin's 'event_cancelled' switch are both on. The one guarded UPDATE is the only write: a second cancel (or two
 * pressed at once) finds it cancelled, is refused, and sends no second notice. Returns how many people were rung.
 */
export async function cancelEvent(sessionId: string, actor: Actor, reason: string | null): Promise<{ notified: number }> {
  const why = reason?.trim() ? reason.trim() : null;
  const row = await takeStep(sessionId, actor, 'cancel', 'event.cancelled', async (client) => {
    const updated = await client.query(
      `UPDATE sessions
          SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3,
              lobby_room_id = NULL, updated_at = NOW()
        WHERE id = $1
          AND status NOT IN ('cancelled', 'completed')
          AND status NOT IN ('lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby')
        RETURNING id`,
      [sessionId, actor.userId, why],
    );
    return (updated.rowCount ?? 0) > 0;
  }, why ?? undefined);
  await tellEveryone(sessionId, row.pod_id);
  const notified = await noticeOfCancellation(row, actor, why);
  return { notified };
}

/** The bells (one statement, then each person's live tags) and, in the background, the emails. Never throws. */
async function noticeOfCancellation(row: LifecycleRow, actor: Actor, reason: string | null): Promise<number> {
  try {
    const recipients = await query<CancelRecipient>(
      `SELECT u.id, u.email, u.timezone, u.notify_email
         FROM users u
        WHERE u.id <> $2 AND ${activeMemberSql('u')}
          AND (u.id IN (SELECT sp.user_id FROM session_participants sp WHERE sp.session_id = $1 AND sp.status <> 'removed')
               OR u.id IN (SELECT c.user_id FROM session_cohosts c WHERE c.session_id = $1))`,
      [row.id, actor.userId],
    );
    if (recipients.rows.length === 0) return 0;
    const title = `${row.title} was cancelled`;
    const body = reason ?? CANCEL_FALLBACK_BODY;
    const link = `/sessions/${row.id}`;
    const inserted = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT r.id, 'event_cancelled', $2, $3, $4 FROM users r WHERE r.id = ANY($1::uuid[])
       RETURNING id, user_id, created_at`,
      [recipients.rows.map((r) => r.id), title, body, link],
    );
    const io = getRealtimeIo();
    if (io) {
      for (const bell of inserted.rows) {
        io.to(`user:${bell.user_id}`).emit('notification:new', {
          id: bell.id, type: 'event_cancelled', title, body, link, isRead: false, createdAt: bell.created_at,
        });
        emitEntities(io, [bell.user_id], [E.userNotifications(bell.user_id)]).catch(() => {});
      }
    }
    void emailCancellation(row, actor, reason, recipients.rows);
    return inserted.rows.length;
  } catch (err) {
    logger.warn({ err, sessionId: row.id }, 'Event cancelled, but its notices could not all be sent (non-fatal)');
    return 0;
  }
}

/** One email each, in the bulk lane, to the people whose email switch is on, while the admin switch is on. */
export async function emailCancellation(
  row: Pick<LifecycleRow, 'id' | 'title' | 'scheduled_at'>,
  actor: Actor,
  reason: string | null,
  recipients: CancelRecipient[],
): Promise<number> {
  try {
    if (!(await emailService.isEmailTypeEnabled('event_cancelled'))) return 0;
    const wanted = recipients.filter((r) => r.email && r.notify_email !== false);
    if (wanted.length === 0) return 0;
    const named = await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [actor.userId]);
    const hostName = named.rows[0]?.display_name?.trim() || 'The organiser';
    const link = `${config.clientUrl}/sessions/${row.id}`;
    return await emailService.asBulkEmail(async () => {
      let sent = 0;
      for (const person of wanted) {
        const t = row.scheduled_at ? meetingTime(new Date(row.scheduled_at), person.timezone) : null;
        const when = t ? `${t.long} (${t.zone})` : 'a time not yet set';
        const result = await emailService.sendEventCancelledEmail(person.email as string, {
          eventTitle: row.title, hostName, when, reason, link,
        }).catch((err: unknown) => {
          logger.warn({ err, sessionId: row.id, userId: person.id }, 'Event-cancelled email failed (non-fatal)');
          return { sent: false };
        });
        if (result.sent) sent += 1;
      }
      return sent;
    });
  } catch (err) {
    logger.warn({ err, sessionId: row.id }, 'Event-cancelled emails could not be sent (non-fatal)');
    return 0;
  }
}

/** An event that ended or was cancelled is put away: out of every default list, back with "archived" for its people. */
export async function archiveEvent(sessionId: string, actor: Actor): Promise<void> {
  const row = await takeStep(sessionId, actor, 'archive', 'event.archived', async (client) => {
    const updated = await client.query(
      `UPDATE sessions SET archived_at = NOW(), archived_by = $2, updated_at = NOW()
        WHERE id = $1 AND archived_at IS NULL AND status IN ('completed', 'cancelled')
        RETURNING id`,
      [sessionId, actor.userId],
    );
    return (updated.rowCount ?? 0) > 0;
  });
  await tellEveryone(sessionId, row.pod_id);
}

/** An archived event comes back to the default lists, as it was. */
export async function unarchiveEvent(sessionId: string, actor: Actor): Promise<void> {
  const row = await takeStep(sessionId, actor, 'unarchive', 'event.unarchived', async (client) => {
    const updated = await client.query(
      `UPDATE sessions SET archived_at = NULL, archived_by = NULL, updated_at = NOW()
        WHERE id = $1 AND archived_at IS NOT NULL
        RETURNING id`,
      [sessionId],
    );
    return (updated.rowCount ?? 0) > 0;
  });
  await tellEveryone(sessionId, row.pod_id);
}

/**
 * A super admin deletes an event for good, typing its name to say so (trimmed, any case). Refused while it is live.
 * The `event.deleted` row with what the event was is written in the same transaction as the deletes (hardDeleteSession),
 * so the trail outlives the event. Everyone who could see it in a list is read first and told after.
 */
export async function deleteEventPermanently(sessionId: string, actor: Actor, confirmTitle: string): Promise<void> {
  const { withSessionGuard } = await import('../orchestration/state/session-state');
  const podId = await withSessionGuard(sessionId, async () => {
    const row = await transaction(async (client) =>
      assertMayTake(await readLifecycleRow(client, sessionId, actor.userId), actor, 'delete_permanently', sessionId));
    if (confirmTitle.trim().toLowerCase() !== row.title.trim().toLowerCase()) {
      throw new ValidationError(DELETE_TITLE_MISMATCH, { confirmTitle: [DELETE_TITLE_MISMATCH] });
    }
    await fanoutSessionEntities(row.pod_id, sessionId);
    const audience = await resolveSessionListAudience(row.pod_id, sessionId).catch((err: unknown) => {
      logger.warn({ err, sessionId }, 'Permanent delete: could not read who to tell beforehand, so only the pod will be told (non-fatal)');
      return undefined;
    });
    await hardDeleteSession(sessionId, { actorId: actor.userId, refuseWhileLive: true });
    await fanoutSessionListEntities(row.pod_id, sessionId, audience);
    return row.pod_id;
  });
  logger.info({ sessionId, actorId: actor.userId, podId }, 'Event deleted for good');
}
