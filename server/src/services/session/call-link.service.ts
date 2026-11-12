// ─── The RSN Call link: codes and the landing (Part 2 foundation, Task 6, 11 Nov 2026; spec 04) ───────────
//
// Every event has one link anyone can open (shared/src/events/call-link.ts): /call/<code>. This file owns the code
// (sessions.call_code, migration 139: 50 bits, unique) and what the link shows before anyone signs in. Entering is
// call-entry.service.ts.
//
// Brute force and enumeration (Review Focus 4): a malformed code, an unknown one, a draft's (to anyone who does not run
// it) and a deleted event's all answer one identical 404, "We couldn't find that event.", so a code tells nothing about
// an event someone may not see. The routes add per-address limits that count only those 404s.

import {
  DEFAULT_GROUP_QUESTION, ErrorCodes, callLinkPath, eventDurationMinutes,
  eventLifecycleOf, eventLinkPath, eventLinkSlug, eventZone, isEventPublication, normaliseCallCode, parseEventLinkSlug,
  resolveEventFormat,
  type AccountKind, type AdmissionMode, type CallLanding, type CallLandingGroupAsk, type EffectiveAdmission,
  type EventLifecycle, type EventLinkInfo, type EventLinksForOrganiser, type EventVisibility, type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import { clientOriginConfig, firstAllowedClientBaseUrl } from '../identity/client-origin';
import logger from '../../config/logger';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { canActAsHost } from '../roles/effective-role.service';
import type { Actor } from '../roles/actor';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { getEventGroupRules } from './event-groups.service';
import { questionsToAsk } from './event-questions.service';
import { readEventAccessFacts, runsEvent } from './event-access';
import { eventImageColumns, eventImageUrlOf } from './event-image-url';
import {
  ensureEventLink, ensureEventLinkState, eventLinkInfo, eventLinkMatchSql, eventLinkNeedsTailSql, newCallCode,
  rotateEventLinkTail, settledEventLink, type EventLinkColumns,
} from './event-link.service';

/** The one answer for a code that leads nowhere the asker may go: malformed, unknown, a hidden draft, a deleted event. */
export const CALL_LINK_NOT_FOUND = "We couldn't find that event.";

export function callLinkNotFound(): NotFoundError {
  return new NotFoundError('Session', undefined, CALL_LINK_NOT_FOUND);
}

// A new call code (event-link.service.ts draws it: turning an event private replaces its public code there too).
export { newCallCode };

const UNIQUE_VIOLATION = '23505';
const CODE_TRIES = 3;

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === UNIQUE_VIOLATION;

/** The organisers' call-link card, told a code was given or changed. Best-effort: a failure never undoes the write. */
async function fanoutCallLink(sessionId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const organisers = await resolveEventOrganiserIds(sessionId);
    await emitEntities(io, organisers, [E.sessionCallLink(sessionId), E.session(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutCallLink: failed to fan out');
  }
}

/**
 * A call code that opens the event now, for links the server sends on its own (a promoted guest's bell and email):
 * the event link is put right first, which replaces a code given out while the event was public (rereview minor 2).
 */
export async function workingCallCode(sessionId: string): Promise<string> {
  const state = await ensureEventLinkState(sessionId);
  return state.callCode ?? ensureCallCode(sessionId);
}

/**
 * The event's call code, giving it one the first time it is asked for (an event made before migration 139). The write
 * is guarded (`call_code IS NULL`), so two first asks agree on one code; a new code that collides with another event's
 * is drawn again, three times at most. 404 when the event does not exist.
 */
export async function ensureCallCode(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
    const current = await query<{ call_code: string | null }>(`SELECT call_code FROM sessions WHERE id = $1`, [sessionId]);
    if (!current.rows[0]) throw callLinkNotFound();
    if (current.rows[0].call_code) return current.rows[0].call_code;
    try {
      const set = await query<{ call_code: string }>(
        // Given while the event is not public, a code keeps working while it stays so; else it is a public one.
        `UPDATE sessions s SET call_code = $2, call_code_private = ${eventLinkNeedsTailSql('s')}
          WHERE s.id = $1 AND s.call_code IS NULL RETURNING s.call_code`,
        [sessionId, newCallCode()],
      );
      if (set.rows[0]) {
        void fanoutCallLink(sessionId);
        return set.rows[0].call_code;
      }
      // Someone else gave it a code between the read and the write: the loop reads theirs.
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, 'We could not make the event link just now. Please try again.');
}

/** Whether the person may manage the event's link: canActAsHost (host, co-host, pod admin, super admin). */
async function requireOrganiser(sessionId: string, actor: Actor): Promise<void> {
  const exists = await query(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId]);
  if (!exists.rows[0]) throw new NotFoundError('Session', sessionId, CALL_LINK_NOT_FOUND);
  const { allowed } = await canActAsHost(actor.userId, actor.role, sessionId);
  if (!allowed) throw new ForbiddenError('Only the people running this event can manage its link.');
}

/**
 * The event's links for its organisers: the call link (the code, the client path and the full address, on the site they
 * asked from when it is one of ours by sign-in's exact list, else the main app) and the event link (event-link.service.ts:
 * EVENT_LINK_BASE_URL when set, else the same site). A failure to read the event link leaves it out: the call link card
 * still works.
 */
export async function getCallLinkForOrganiser(
  sessionId: string,
  actor: Actor,
  opts: { origin?: string } = {},
  read: { eventLinkOptional?: boolean } = {},
): Promise<EventLinksForOrganiser> {
  await requireOrganiser(sessionId, actor);
  // The event link first: putting it right may replace a call code given out while the event was public. When it
  // cannot be read, nothing is shown rather than a call link that may be dead (rereview minor 1): the card says so and
  // offers to try again. `eventLinkOptional` (just after "Make a new link", rereview 2 minor 1): the call code was just
  // made for the event as it is, so it opens it; the answer is that link, without the event link, never a failure for a
  // rotation that happened.
  let eventLink: EventLinkInfo | null = null;
  try {
    eventLink = await eventLinkInfo(sessionId, opts);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) throw err;
    logger.warn({ err, sessionId }, 'getCallLinkForOrganiser: the event link could not be read');
    if (!read.eventLinkOptional) {
      throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, 'We could not read the event link just now. Please try again.');
    }
  }
  const code = await ensureCallCode(sessionId);
  const base = firstAllowedClientBaseUrl([opts.origin], clientOriginConfig());
  const callLink = { code, path: callLinkPath(code), url: `${base}${callLinkPath(code)}` };
  return eventLink ? { ...callLink, eventLink } : callLink;
}

/**
 * Give the event a new call code: the old link stops working at once (nothing else holds it). An event link with a tail
 * gets a new tail too, and its old tailed links are forgotten (event-link.service.ts, rotateEventLinkTail): the same
 * leak stops by either door. Organisers only, audited `call_link.rotated` (the codes themselves are never written to the
 * trail). The organisers' card redraws.
 */
export async function rotateCallCode(sessionId: string, actor: Actor): Promise<string> {
  await requireOrganiser(sessionId, actor);
  for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
    try {
      const code = await transaction(async (client) => {
        const set = await client.query<{ call_code: string }>(
          `UPDATE sessions s SET call_code = $2, call_code_private = ${eventLinkNeedsTailSql('s')} WHERE s.id = $1 RETURNING s.call_code`,
          [sessionId, newCallCode()],
        );
        if (!set.rows[0]) throw callLinkNotFound();
        await rotateEventLinkTail(client, sessionId);
        await recordEventAudit({ sessionId, actorId: actor.userId, action: 'call_link.rotated', automatic: false }, client);
        return set.rows[0].call_code;
      });
      void fanoutCallLink(sessionId);
      void emitEventAuditChanged(sessionId);
      return code;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, 'We could not make a new event link just now. Please try again.');
}

// ─── Reading a code ──────────────────────────────────────────────────────────

/** The event row the link reads: what the landing shows and what decides who may see it. */
export interface CallEventRow extends EventLinkColumns {
  id: string;
  call_code: string;
  title: string;
  description: string | null;
  scheduled_at: Date | null;
  config: unknown;
  event_format: string | null;
  status: string;
  publication: string | null;
  archived_at: Date | null;
  registration_opens_at: Date | null;
  visibility: string | null;
  admission_mode: string | null;
  host_user_id: string;
  host_name: string | null;
  host_avatar: string | null;
  /** Part 3 Task 1: the event's zone and whether it has an image (absent on a row built by hand: UTC, none). */
  timezone?: string | null;
  has_image?: boolean | null;
  image_updated_at?: Date | null;
  /** How the asker reached the event: its event link (/events/<slug>) or its call link (/call/<code>). Absent: the code. */
  reached_by?: 'event_link' | 'call_code';
}

const CALL_EVENT_COLUMNS = `s.id, s.call_code, s.title, s.description, s.scheduled_at, s.config, s.event_format, s.status::text AS status,
            s.publication, s.archived_at, s.registration_opens_at, s.visibility, s.admission_mode, s.host_user_id,
            h.display_name AS host_name, h.avatar_url AS host_avatar, s.timezone, ${eventImageColumns('s')},
            s.link_name, s.link_number, s.link_tail, ${eventLinkNeedsTailSql('s')} AS link_needs_tail, s.call_code_private`;

/**
 * The event a well-formed, known link names, whatever its state, or null. Callers decide who may see a draft. `raw` is an
 * event link's slug ('rsn-3', 'rsn-3-k7m2q9', or one the event had before: event-link.service.ts decides which still
 * open) or a call code; a slug that leads nowhere is read as a code once more (someone typed a code with a dash).
 */
export async function findCallEvent(raw: string): Promise<CallEventRow | null> {
  const slug = parseEventLinkSlug(raw);
  if (slug) {
    const bySlug = await query<CallEventRow>(
      `SELECT ${CALL_EVENT_COLUMNS}
         FROM sessions s LEFT JOIN users h ON h.id = s.host_user_id WHERE s.id = (${eventLinkMatchSql()})`,
      [slug.name, slug.number, slug.tail, eventLinkSlug(slug)],
    );
    if (bySlug.rows[0]) return { ...bySlug.rows[0], reached_by: 'event_link' };
  }
  const code = normaliseCallCode(raw);
  if (!code) return null;
  // A code given out while the event was public opens it only while it is public (controller ruling, 12 Nov 2026): once
  // it is private or invitation-only, that code is the same 404 as its bare event link.
  const result = await query<CallEventRow>(
    `SELECT ${CALL_EVENT_COLUMNS}
       FROM sessions s LEFT JOIN users h ON h.id = s.host_user_id WHERE s.call_code = $1
        AND (s.call_code_private OR NOT ${eventLinkNeedsTailSql('s')})`,
    [code],
  );
  return result.rows[0] ? { ...result.rows[0], reached_by: 'call_code' } : null;
}

/**
 * The event's link as it is now, for a row findCallEvent read: from the row when it is settled, else put right first
 * (ensureEventLink). Null when it cannot be read just now: the caller then goes on without it.
 */
export async function currentEventLinkOf(event: CallEventRow): Promise<{ slug: string; path: string } | null> {
  try {
    const parts = settledEventLink(event) ?? await ensureEventLink(event.id);
    const slug = eventLinkSlug(parts);
    return { slug, path: eventLinkPath(slug) };
  } catch (err) {
    logger.warn({ err, sessionId: event.id }, 'currentEventLinkOf: the event link could not be read');
    return null;
  }
}

/**
 * The key the asker's next calls use, and the path an email sends them back to: the event link as it is now when they
 * came by one (a public event's link never hands out its call code), else the call code, as before.
 */
export async function entryKeyOf(
  event: CallEventRow, link?: { slug: string; path: string } | null,
): Promise<{ key: string; path: string }> {
  if (event.reached_by === 'event_link') {
    const now = link === undefined ? await currentEventLinkOf(event) : link;
    if (now) return { key: now.slug, path: now.path };
  }
  return { key: event.call_code, path: callLinkPath(event.call_code) };
}

/** The event a code leads to for anyone (a draft is hidden from everyone here), or null: one identical 404 for all. */
export async function resolveCallCode(raw: string): Promise<{ sessionId: string } | null> {
  const event = await findCallEvent(raw);
  if (!event || event.publication === 'draft') return null;
  return { sessionId: event.id };
}

/**
 * The event a code leads to for this viewer: a draft only for someone who runs it (host, co-host, admin: who sees a
 * draft's page). Everything else that leads nowhere throws the one 404.
 */
export async function eventForViewer(
  raw: string,
  viewer: { userId: string; role: UserRole } | null,
): Promise<CallEventRow> {
  const event = await findCallEvent(raw);
  if (!event) throw callLinkNotFound();
  if (event.publication !== 'draft') return event;
  if (!viewer) throw callLinkNotFound();
  const facts = await readEventAccessFacts(event.id, viewer.userId);
  if (!facts || !runsEvent(facts, viewer.role)) throw callLinkNotFound();
  return event;
}

/** Where the event stands (D1's one rule). */
export function lifecycleOfCallEvent(event: CallEventRow): EventLifecycle {
  return eventLifecycleOf({
    status: event.status,
    publication: isEventPublication(event.publication) ? event.publication : 'published',
    archivedAt: event.archived_at,
    registrationOpensAt: event.registration_opens_at,
  });
}

const ADMISSION_MODES_READ: readonly string[] = ['open', 'approval', 'restricted'];

/** The event's admission mode, or null (today's rules). */
export function admissionModeOf(event: CallEventRow): AdmissionMode | null {
  return event.admission_mode && ADMISSION_MODES_READ.includes(event.admission_mode)
    ? event.admission_mode as AdmissionMode
    : null;
}

/** What decides a place (event-access.ts effectiveAdmission, read from the row alone). */
export function effectiveAdmissionOf(event: CallEventRow): EffectiveAdmission {
  const mode = admissionModeOf(event);
  if (mode) return mode;
  return event.visibility === null ? 'pod_rules' : 'members_only';
}

/** The event's group question for the landing, or null when it has no groups. */
export async function groupAskOf(sessionId: string): Promise<CallLandingGroupAsk | null> {
  const rules = await getEventGroupRules(sessionId);
  if (!rules) return null;
  return {
    question: rules.question || DEFAULT_GROUP_QUESTION,
    options: rules.groups.map((g) => ({ key: g.key, label: g.label })),
    multiple: rules.allowMultiple,
  };
}

/**
 * What the link shows: the event's title, time, length, format, host and state, what it will ask for, and where the
 * viewer stands. Never the participants, the pod or the invitees. `viewer.sessionId` only for a signed-in viewer who
 * holds a place (not removed) or runs the event.
 */
export async function getCallLanding(
  code: string,
  viewer: { userId: string; role: UserRole } | null,
): Promise<CallLanding> {
  const event = await eventForViewer(code, viewer);
  const lifecycle = lifecycleOfCallEvent(event);
  const format = resolveEventFormat({ format: event.event_format, config: event.config as object | null });
  const group = await groupAskOf(event.id);
  const mode = admissionModeOf(event);
  // The event link as it is now: the page shows it in the address bar (an old call link or a renamed event's old link
  // turns into the one to share). Reached by an event link, `code` is that link, never the call code.
  const link = await currentEventLinkOf(event);
  const { key } = await entryKeyOf(event, link);
  const base = {
    code: key,
    title: event.title,
    description: event.description,
    scheduledAt: event.scheduled_at ? new Date(event.scheduled_at).toISOString() : null,
    timezone: eventZone(event.timezone),
    imageUrl: eventImageUrlOf(event.id, event),
    durationMinutes: eventDurationMinutes(format, (event.config ?? null) as object | null),
    format,
    host: { displayName: event.host_name?.trim() || 'The organiser', avatarUrl: event.host_avatar ?? null },
    lifecycle,
    admission: effectiveAdmissionOf(event),
  };
  if (!viewer) {
    // Part 3 Task 5: every matching question the event asks (required first); never anyone's answers.
    const questions = await questionsToAsk(event.id, null, event.status);
    return {
      ...base,
      asks: { displayName: true, group, admissionCode: mode === 'restricted', questions },
      viewer: { signedIn: false, accountKind: null, sessionId: null, step: 'identify' },
      ...(link ? { link } : {}),
    };
  }
  // The signed-in viewer's own state: the same reading GET /call-links/:code/entry gives (a lazy import: call-entry
  // reads this file).
  const { readCallEntryForEvent } = await import('./call-entry.service');
  const state = await readCallEntryForEvent(event, viewer.userId, viewer.role);
  const kind = await query<{ account_kind: AccountKind }>(`SELECT account_kind FROM users WHERE id = $1`, [viewer.userId]);
  // Part 3 Task 5: the questions this viewer has not answered, only while there is a step that asks them.
  const questions = state.step === 'details' || state.step === 'request'
    ? await questionsToAsk(event.id, viewer.userId, event.status)
    : null;
  return {
    ...base,
    asks: {
      displayName: state.missing.displayName, group: state.missing.group ? group : null,
      admissionCode: state.missing.admissionCode, questions,
    },
    viewer: {
      signedIn: true,
      accountKind: kind.rows[0]?.account_kind ?? null,
      sessionId: state.sessionId,
      step: state.step,
    },
    ...(link ? { link } : {}),
  };
}

/** The visibility a row carries, typed (null: the event follows its pod). */
export function visibilityOf(event: CallEventRow): EventVisibility | null {
  return event.visibility === 'public' || event.visibility === 'public_with_approval' || event.visibility === 'private'
    ? event.visibility
    : null;
}
