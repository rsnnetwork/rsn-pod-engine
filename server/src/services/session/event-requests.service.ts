// ─── Requests to join an event that asks the host to approve each place (T11, 1 Nov 2026; L17) ─────────────
//
// A request is a row of event_join_requests, never a participant row, so no count, capacity or room admission
// reads it as "in". The person asks (only when the event needs approval for them), may withdraw, and the event's
// organisers (host, co-hosts, the pod's active directors and hosts, admins) approve or decline. Approving
// registers them through registerParticipant, so capacity, a removal and every other rule still decide.
// These rows are approval records: never delete them in a cleanup.

import { ErrorCodes, type ErrorCode, type EventJoinRequestStatus, type UserRole } from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { activeMemberSql } from '../users/active-member';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import {
  EVENT_PRIVATE_SENTENCE, canSeeEvent, managesRequests, needsApproval, readEventAccessFacts, type EventAccessFacts,
} from './event-access';
import { registerOrWaitlist } from './event-waitlist.service';
import { recordEventAudit } from '../audit/event-audit';

export interface EventJoinRequest {
  id: string;
  sessionId: string;
  userId: string;
  status: EventJoinRequestStatus;
  message: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** A request as the organisers' Requests card lists it: the requester's public card, never their email. */
export interface EventJoinRequestCard extends EventJoinRequest {
  displayName: string;
  firstName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
}

const REQUEST_COLUMNS = `r.id, r.session_id AS "sessionId", r.user_id AS "userId", r.status, r.message,
  r.created_at AS "createdAt", r.decided_at AS "decidedAt"`;

async function factsOrNotFound(sessionId: string, userId: string): Promise<EventAccessFacts> {
  const facts = await readEventAccessFacts(sessionId, userId);
  if (!facts) throw new NotFoundError('Session', sessionId, "We couldn't find that event.");
  return facts;
}

async function requireManager(sessionId: string, userId: string, role: UserRole | undefined): Promise<EventAccessFacts> {
  const facts = await factsOrNotFound(sessionId, userId);
  if (!managesRequests(facts, role)) {
    throw new ForbiddenError("Only the people running this event can answer its requests.");
  }
  return facts;
}

// ─── Telling people ──────────────────────────────────────────────────────────

/** Every screen that shows this event's requests: the organisers' Requests card and the requester's own state. */
export async function fanoutJoinRequests(sessionId: string, requesterId: string, extra: string[] = []): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const organisers = await resolveEventOrganiserIds(sessionId);
    const people = [...new Set([...organisers, requesterId])];
    await emitEntities(io, people, [E.sessionJoinRequests(sessionId), E.session(sessionId), ...extra]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutJoinRequests: failed to fan out');
  }
}

/** The two existing bell types the request flow uses (no new type: only migration 118 touches the type list). */
type EventRequestBell = 'join_request' | 'approval';

/** One bell row per person, pushed live. A bell that fails never undoes the request. */
async function ring(
  userIds: string[],
  type: EventRequestBell,
  bell: { title: string; body: string; link: string },
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const inserted = await query<{ id: string; user_id: string; created_at: Date }>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT unnest($1::uuid[]), $2, $3, $4, $5
       RETURNING id, user_id, created_at`,
      [userIds, type, bell.title, bell.body, bell.link],
    );
    const io = getRealtimeIo();
    if (!io) return;
    for (const row of inserted.rows) {
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type, title: bell.title, body: bell.body, link: bell.link, isRead: false, createdAt: row.created_at,
      });
      emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)]).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, type }, 'Event request bell failed (non-fatal)');
  }
}

async function eventTitleAndName(sessionId: string, userId: string): Promise<{ title: string; name: string }> {
  const r = await query<{ title: string; name: string | null }>(
    `SELECT s.title, COALESCE(NULLIF(u.first_name, ''), NULLIF(u.display_name, ''), 'Someone') AS name
       FROM sessions s, users u WHERE s.id = $1 AND u.id = $2`,
    [sessionId, userId],
  );
  return { title: r.rows[0]?.title ?? 'your event', name: r.rows[0]?.name ?? 'Someone' };
}

// ─── Asking, withdrawing ─────────────────────────────────────────────────────

/**
 * Ask for a place. Only when the event needs approval for this person. Asking again while pending changes
 * nothing; a withdrawn request is asked again; a declined one stays declined.
 *
 * Part 2 Task 6: `arrivedThroughCallLink` (call-entry.service's enterCall, the only caller that says so) is someone
 * holding the event's own RSN Call link. A private event with an admission mode is unlisted, not closed (D3: link
 * only), so the link is how they see it: the page-visibility check is the link's, and needsApproval still decides.
 */
export async function requestToJoin(
  sessionId: string,
  userId: string,
  role: UserRole | undefined,
  message: string | null,
  options: { arrivedThroughCallLink?: boolean } = {},
): Promise<EventJoinRequest> {
  const facts = await factsOrNotFound(sessionId, userId);
  const seesIt = canSeeEvent(facts, role) || (!!options.arrivedThroughCallLink && facts.admissionMode !== null && facts.accountActive);
  if (!seesIt) throw new AppError(403, ErrorCodes.EVENT_PRIVATE, EVENT_PRIVATE_SENTENCE);
  if (facts.myRequest === 'declined') {
    throw new ConflictError(ErrorCodes.EVENT_REQUEST_DECLINED, 'The host has declined your request for this event.');
  }
  if (!needsApproval(facts, role)) {
    if (facts.participantStatus === 'removed') {
      throw new AppError(403, 'REMOVED_FROM_EVENT' as ErrorCode, 'You have been removed from this event by the host');
    }
    throw new ConflictError(ErrorCodes.EVENT_REQUEST_NOT_NEEDED, 'You do not need to ask: you can register for this event.');
  }

  const result = await query<EventJoinRequest & { opened: boolean }>(
    `INSERT INTO event_join_requests AS r (session_id, user_id, status, message)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET status = 'pending', message = EXCLUDED.message, decided_at = NULL, decided_by = NULL, updated_at = NOW()
       WHERE r.status = 'withdrawn'
     RETURNING ${REQUEST_COLUMNS}, TRUE AS opened`,
    [sessionId, userId, message],
  );
  let request = result.rows[0];
  if (!request) {
    // Already pending (or decided meanwhile): the row as it is, no second bell.
    const existing = await query<EventJoinRequest>(
      `SELECT ${REQUEST_COLUMNS} FROM event_join_requests r WHERE r.session_id = $1 AND r.user_id = $2`,
      [sessionId, userId],
    );
    request = { ...existing.rows[0], opened: false };
    if (request.status === 'declined') {
      throw new ConflictError(ErrorCodes.EVENT_REQUEST_DECLINED, 'The host has declined your request for this event.');
    }
  }

  if (request.opened) {
    const { title, name } = await eventTitleAndName(sessionId, userId);
    const organisers = (await resolveEventOrganiserIds(sessionId)).filter((id) => id !== userId);
    await ring(organisers, 'join_request', {
      title: 'New request to join',
      body: `${name} wants to join ${title}`,
      link: `/sessions/${sessionId}?requests=1`,
    });
  }
  fanoutJoinRequests(sessionId, userId).catch(() => {});
  const { opened: _opened, ...out } = request;
  return out;
}

/** Withdraw one's own pending request. Nothing pending: nothing changes. */
export async function withdrawRequest(sessionId: string, userId: string): Promise<{ withdrawn: boolean }> {
  const result = await query(
    `UPDATE event_join_requests SET status = 'withdrawn', updated_at = NOW()
      WHERE session_id = $1 AND user_id = $2 AND status = 'pending'`,
    [sessionId, userId],
  );
  const withdrawn = (result.rowCount ?? 0) > 0;
  if (withdrawn) fanoutJoinRequests(sessionId, userId).catch(() => {});
  return { withdrawn };
}

// ─── The organisers' side ────────────────────────────────────────────────────

/** The event's requests in one status (pending by default), newest last; only active accounts are listed. */
export async function listRequests(
  sessionId: string,
  viewerId: string,
  role: UserRole | undefined,
  status: EventJoinRequestStatus = 'pending',
): Promise<EventJoinRequestCard[]> {
  await requireManager(sessionId, viewerId, role);
  const result = await query<EventJoinRequestCard>(
    `SELECT ${REQUEST_COLUMNS},
            COALESCE(u.display_name, '') AS "displayName", COALESCE(u.first_name, '') AS "firstName",
            u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle", u.company
       FROM event_join_requests r
       JOIN users u ON u.id = r.user_id
      WHERE r.session_id = $1 AND r.status = $2 AND ${activeMemberSql('u')}
      ORDER BY r.created_at ASC
      LIMIT 200`,
    [sessionId, status],
  );
  return result.rows;
}

/**
 * Approve: the request row is locked, the person is registered (a removed person stays removed), then the request is
 * approved. Part 3 Task 3: on a full event the approval still stands (it is the organiser's say-so; capacity is a
 * separate fact) and the person joins the waiting list (`waitlistPosition`), to be promoted with that approval when a
 * place frees. Before, a full event answered SESSION_FULL and left the request pending for the organiser to re-approve.
 */
export async function approveRequest(
  sessionId: string,
  requesterId: string,
  approverId: string,
  role: UserRole | undefined,
): Promise<{ request: EventJoinRequest; isNewRegistration: boolean; waitlistPosition: number | null }> {
  await requireManager(sessionId, approverId, role);
  const outcome = await transaction(async (client) => {
    const locked = await client.query<EventJoinRequest>(
      `SELECT ${REQUEST_COLUMNS} FROM event_join_requests r
        WHERE r.session_id = $1 AND r.user_id = $2 FOR UPDATE`,
      [sessionId, requesterId],
    );
    const row = locked.rows[0];
    if (!row) throw new NotFoundError('Request', requesterId, 'That request to join was not found.');
    if (row.status !== 'pending') {
      throw new ConflictError(ErrorCodes.EVENT_REQUEST_ANSWERED, 'That request has already been answered.');
    }
    const account = await client.query<{ active: boolean }>(
      `SELECT ${activeMemberSql('u')} AS active FROM users u WHERE u.id = $1`,
      [requesterId],
    );
    if (!account.rows[0]?.active) {
      throw new ConflictError(ErrorCodes.EVENT_REQUEST_ANSWERED, 'This person is no longer a member of REASON.');
    }
    // The registration's own rules decide (a removal, the account); a refusal leaves the request pending. A full event
    // queues them instead (registerOrWaitlist).
    const placed = await registerOrWaitlist(sessionId, requesterId, undefined, { approvedRequest: true, joinedVia: 'approval' })
      .catch((err: { code?: string }) => {
        if (err?.code === ErrorCodes.SESSION_ALREADY_REGISTERED) return null;
        throw err;
      });
    const isNewRegistration = placed?.kind === 'registered' && placed.isNewRegistration;
    const waitlistPosition = placed?.kind === 'waitlisted' ? placed.position : null;
    const approved = await client.query<EventJoinRequest>(
      `UPDATE event_join_requests r SET status = 'approved', decided_at = NOW(), decided_by = $3, updated_at = NOW()
        WHERE r.session_id = $1 AND r.user_id = $2
        RETURNING ${REQUEST_COLUMNS}`,
      [sessionId, requesterId, approverId],
    );
    return { request: approved.rows[0], isNewRegistration, waitlistPosition };
  });

  void recordEventAudit({
    sessionId, actorId: approverId, action: 'admission.request_approved', automatic: false, subjectUserIds: [requesterId],
  });
  const { title } = await eventTitleAndName(sessionId, requesterId);
  await ring([requesterId], 'approval', {
    title: 'Your request was approved',
    body: outcome.waitlistPosition === null
      ? `You have a place in ${title}.`
      : `${title} is full, so you're number ${outcome.waitlistPosition} on the waiting list. We'll tell you the moment a place opens.`,
    link: `/sessions/${sessionId}`,
  });
  return outcome;
}

/** Decline a pending request. The requester cannot reopen it. */
export async function declineRequest(
  sessionId: string,
  requesterId: string,
  approverId: string,
  role: UserRole | undefined,
): Promise<EventJoinRequest> {
  await requireManager(sessionId, approverId, role);
  const result = await query<EventJoinRequest>(
    `UPDATE event_join_requests r SET status = 'declined', decided_at = NOW(), decided_by = $3, updated_at = NOW()
      WHERE r.session_id = $1 AND r.user_id = $2 AND r.status = 'pending'
      RETURNING ${REQUEST_COLUMNS}`,
    [sessionId, requesterId, approverId],
  );
  if (!result.rows[0]) throw new ConflictError(ErrorCodes.EVENT_REQUEST_ANSWERED, 'That request has already been answered.');
  void recordEventAudit({
    sessionId, actorId: approverId, action: 'admission.request_declined', automatic: false, subjectUserIds: [requesterId],
  });
  fanoutJoinRequests(sessionId, requesterId).catch(() => {});
  return result.rows[0];
}
