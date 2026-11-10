// ─── The RSN Call link: codes and the landing (Part 2 foundation, Task 6, 11 Nov 2026; spec 04) ───────────
//
// Every event has one link anyone can open (shared/src/events/call-link.ts): /call/<code>. This file owns the code
// (sessions.call_code, migration 139: 50 bits, unique) and what the link shows before anyone signs in. Entering is
// call-entry.service.ts.
//
// Brute force and enumeration (Review Focus 4): a malformed code, an unknown one, a draft's (to anyone who does not run
// it) and a deleted event's all answer one identical 404, "We couldn't find that event.", so a code tells nothing about
// an event someone may not see. The routes add per-address limits that count only those 404s.

import crypto from 'crypto';
import {
  CALL_CODE_ALPHABET, CALL_CODE_LENGTH, DEFAULT_GROUP_QUESTION, ErrorCodes, callLinkPath, eventDurationMinutes,
  eventLifecycleOf, isEventPublication, normaliseCallCode, resolveEventFormat,
  type AccountKind, type AdmissionMode, type CallLanding, type CallLandingGroupAsk, type EffectiveAdmission,
  type EventLifecycle, type EventVisibility, type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { canActAsHost } from '../roles/effective-role.service';
import type { Actor } from '../roles/actor';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { getEventGroupRules } from './event-groups.service';
import { readEventAccessFacts, runsEvent } from './event-access';

/** The one answer for a code that leads nowhere the asker may go: malformed, unknown, a hidden draft, a deleted event. */
export const CALL_LINK_NOT_FOUND = "We couldn't find that event.";

export function callLinkNotFound(): NotFoundError {
  return new NotFoundError('Session', undefined, CALL_LINK_NOT_FOUND);
}

/** A new call code: CALL_CODE_LENGTH symbols, each drawn from the operating system's random source. */
export function newCallCode(): string {
  let code = '';
  for (let i = 0; i < CALL_CODE_LENGTH; i++) code += CALL_CODE_ALPHABET[crypto.randomInt(CALL_CODE_ALPHABET.length)];
  return code;
}

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
        `UPDATE sessions SET call_code = $2 WHERE id = $1 AND call_code IS NULL RETURNING call_code`,
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

/** The event's link for its organisers: the code, the client path and the full address. */
export async function getCallLinkForOrganiser(
  sessionId: string,
  actor: Actor,
): Promise<{ code: string; path: string; url: string }> {
  await requireOrganiser(sessionId, actor);
  const code = await ensureCallCode(sessionId);
  return { code, path: callLinkPath(code), url: `${config.clientUrl}${callLinkPath(code)}` };
}

/**
 * Give the event a new call code: the old link stops working at once (nothing else holds it). Organisers only, audited
 * `call_link.rotated` (the codes themselves are never written to the trail). The organisers' card redraws.
 */
export async function rotateCallCode(sessionId: string, actor: Actor): Promise<string> {
  await requireOrganiser(sessionId, actor);
  for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
    try {
      const code = await transaction(async (client) => {
        const set = await client.query<{ call_code: string }>(
          `UPDATE sessions SET call_code = $2 WHERE id = $1 RETURNING call_code`,
          [sessionId, newCallCode()],
        );
        if (!set.rows[0]) throw callLinkNotFound();
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
export interface CallEventRow {
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
}

/** The event a well-formed, known code names, whatever its state, or null. Callers decide who may see a draft. */
export async function findCallEvent(raw: string): Promise<CallEventRow | null> {
  const code = normaliseCallCode(raw);
  if (!code) return null;
  const result = await query<CallEventRow>(
    `SELECT s.id, s.call_code, s.title, s.description, s.scheduled_at, s.config, s.event_format, s.status::text AS status,
            s.publication, s.archived_at, s.registration_opens_at, s.visibility, s.admission_mode, s.host_user_id,
            h.display_name AS host_name, h.avatar_url AS host_avatar
       FROM sessions s
       LEFT JOIN users h ON h.id = s.host_user_id
      WHERE s.call_code = $1`,
    [code],
  );
  return result.rows[0] ?? null;
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
  const base = {
    code: event.call_code,
    title: event.title,
    description: event.description,
    scheduledAt: event.scheduled_at ? new Date(event.scheduled_at).toISOString() : null,
    durationMinutes: eventDurationMinutes(format, (event.config ?? null) as object | null),
    format,
    host: { displayName: event.host_name?.trim() || 'The organiser', avatarUrl: event.host_avatar ?? null },
    lifecycle,
    admission: effectiveAdmissionOf(event),
  };
  if (!viewer) {
    return {
      ...base,
      asks: { displayName: true, group, admissionCode: mode === 'restricted' },
      viewer: { signedIn: false, accountKind: null, sessionId: null, step: 'identify' },
    };
  }
  // The signed-in viewer's own state: the same reading GET /call-links/:code/entry gives (a lazy import: call-entry
  // reads this file).
  const { readCallEntryForEvent } = await import('./call-entry.service');
  const state = await readCallEntryForEvent(event, viewer.userId, viewer.role);
  const kind = await query<{ account_kind: AccountKind }>(`SELECT account_kind FROM users WHERE id = $1`, [viewer.userId]);
  return {
    ...base,
    asks: { displayName: state.missing.displayName, group: state.missing.group ? group : null, admissionCode: state.missing.admissionCode },
    viewer: {
      signedIn: true,
      accountKind: kind.rows[0]?.account_kind ?? null,
      sessionId: state.sessionId,
      step: state.step,
    },
  };
}

/** The visibility a row carries, typed (null: the event follows its pod). */
export function visibilityOf(event: CallEventRow): EventVisibility | null {
  return event.visibility === 'public' || event.visibility === 'public_with_approval' || event.visibility === 'private'
    ? event.visibility
    : null;
}
