// ─── The event link: /events/<name>-<n>[-<tail>] (Stefan, 11 Nov 2026) ───────────────────────────────────────────────
//
// Every event has one link people read and share (shared/src/events/event-link.ts): a name its organiser chooses, the
// next number under that name across all events, and a random tail when the event is not public. The columns are
// sessions.link_name, link_number and link_tail (migration 154); event_link_counters hands out the numbers and
// event_link_aliases keeps the links an event had before.
//
// The rules, each decided here and nowhere else:
//   Numbers   One INSERT ... ON CONFLICT DO UPDATE ... RETURNING on the name's counter row, inside the transaction
//             that gives the event its link: a second event under the same name waits on the row lock and takes the
//             next number. The unique index on (link_name, link_number) holds it besides.
//   Tail      Needed when the event is not public (eventLinkNeedsTailSql: not public or approval by its own visibility
//             or its pod's, or invitation-only, or in a closed circle). Checked on every read, so a link without a tail
//             never opens an event that is not public now, whatever changed it (the event, its pod, its circle).
//   Renamed   The event takes the next number under the new name (or its own old number, when it had that name before)
//             and keeps its tail. The old link is kept as an alias and still leads to the event: people pasted it into
//             calendars, emails and other sites.
//   Public -> not public   A tail is added. The link without it stops at once, with no forwarding: forwarding would
//             hand the tail to anyone who guesses the number.
//   Not public -> public   The tail is dropped. The link with it is kept as an alias (whoever holds it was given it).
//   Rotated   Rotating the call link (call-link.service.ts) draws a new tail and forgets every old link that had one,
//             so a leaked link stops working; a public link has nothing secret to rotate.
// A link that leads nowhere the asker may go answers the call link's one 404 (call-link.service.ts findCallEvent).

import crypto from 'crypto';
import {
  EVENT_LINK_DEFAULT_NAME, EVENT_LINK_TAIL_ALPHABET, EVENT_LINK_TAIL_FIRST, EVENT_LINK_TAIL_LENGTH, ErrorCodes,
  UserRole, eventLinkNameProblem, eventLinkPath, eventLinkSlug, hasRoleAtLeast, isEventVisibility,
  normaliseEventLinkName,
  type EventLinkInfo, type EventLinkNameCheck, type EventLinkParts, type EventVisibility,
} from '@rsn/shared';
import type { QueryResult, QueryResultRow } from 'pg';
import config from '../../config';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { clientOriginConfig, firstAllowedClientBaseUrl } from '../identity/client-origin';
import type { Actor } from '../roles/actor';

const NOT_FOUND = "We couldn't find that event.";
const ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * True (in SQL) when the event aliased `s` needs a tail: it is not public. Public is what publicEventsSql lists when
 * published: a public or approval event by its own visibility, or by its pod's when it has none, outside a closed
 * circle; and not invitation-only (Stefan: private and invitation-only events get a tail). Migration 154's backfill
 * writes the same rule out. Never NULL: `NULL IN (...)` is NULL, which NOT keeps NULL, so the visibility is tested for
 * NULL first, and anything still unknown reads as needing a tail (COALESCE ..., TRUE): a doubt never drops a tail.
 */
export function eventLinkNeedsTailSql(s: string, visibilityParam?: string): string {
  if (!ALIAS.test(s)) throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'eventLinkNeedsTailSql takes a plain alias');
  if (visibilityParam !== undefined && !/^\$[1-9][0-9]*$/.test(visibilityParam)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'eventLinkNeedsTailSql takes a placeholder for the visibility');
  }
  // `visibilityParam` (the event form's preview): the visibility the form would save, read in place of the event's own.
  const v = visibilityParam === undefined ? `${s}.visibility` : `COALESCE(${visibilityParam}::text, ${s}.visibility)`;
  return `COALESCE(NOT (
    ((${v} IS NOT NULL AND ${v} IN ('public', 'public_with_approval'))
      OR (${v} IS NULL AND EXISTS (SELECT 1 FROM pods el_p WHERE el_p.id = ${s}.pod_id AND el_p.visibility = 'public')))
    AND ${s}.admission_mode IS DISTINCT FROM 'restricted'
    AND NOT (${s}.circle_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM circles el_c WHERE el_c.id = ${s}.circle_id AND el_c.join_policy = 'closed'))
  ), TRUE)`;
}

/**
 * The id of the event an event link leads to, as a subquery over $1 name, $2 number, $3 tail (or null) and $4 the slug
 * as written. Its current link first: the tail must match, and a link without one opens only a public event. Else a
 * link it had before: one with a tail always (it was given out while the event was not public), one without only while
 * the event is public.
 */
export function eventLinkMatchSql(): string {
  return `SELECT el_m.id FROM (
      SELECT el_s.id, 1 AS rank FROM sessions el_s
       WHERE el_s.link_name = $1 AND el_s.link_number = $2 AND el_s.link_tail IS NOT DISTINCT FROM $3::text
         AND (el_s.link_tail IS NOT NULL OR NOT ${eventLinkNeedsTailSql('el_s')})
      UNION ALL
      SELECT el_a.session_id, 2 AS rank FROM event_link_aliases el_a JOIN sessions el_as ON el_as.id = el_a.session_id
       WHERE el_a.slug = $4 AND (el_a.secret OR NOT ${eventLinkNeedsTailSql('el_as')})
    ) el_m ORDER BY el_m.rank LIMIT 1`;
}

/** A new tail: a letter, then EVENT_LINK_TAIL_LENGTH - 1 symbols, each from the operating system's random source. */
export function newEventLinkTail(): string {
  let tail = EVENT_LINK_TAIL_FIRST[crypto.randomInt(EVENT_LINK_TAIL_FIRST.length)];
  while (tail.length < EVENT_LINK_TAIL_LENGTH) tail += EVENT_LINK_TAIL_ALPHABET[crypto.randomInt(EVENT_LINK_TAIL_ALPHABET.length)];
  return tail;
}

/** The site event links are written on: EVENT_LINK_BASE_URL when it is an http(s) address, else the asker's (ours). */
export function eventLinkBaseUrl(origin?: string): string {
  const configured = configuredBase(config.eventLinkBaseUrl);
  if (configured) return configured;
  return firstAllowedClientBaseUrl([origin], clientOriginConfig());
}

function configuredBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    // An address that does not parse is left unused: the links fall back to the site asked from.
    return null;
  }
}

// ─── Reading and keeping an event's link ─────────────────────────────────────

interface LinkRow {
  id: string;
  pod_id: string | null;
  circle_id: string | null;
  link_name: string | null;
  link_number: number | null;
  link_tail: string | null;
  needs_tail: boolean;
}

const LINK_ROW_SQL = (lock: boolean) => `SELECT s.id, s.pod_id, s.circle_id, s.link_name, s.link_number, s.link_tail,
        ${eventLinkNeedsTailSql('s')} AS needs_tail
   FROM sessions s WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`;

/** The columns an event row carries for its link (findCallEvent, the lists). */
export interface EventLinkColumns {
  link_name?: string | null;
  link_number?: number | null;
  link_tail?: string | null;
  link_needs_tail?: boolean | null;
}

/** The link as stored, when it is complete and its tail is as the event needs now; else null (ensureEventLink fixes it). */
export function settledEventLink(row: EventLinkColumns): EventLinkParts | null {
  if (!row.link_name || !row.link_number || typeof row.link_needs_tail !== 'boolean') return null;
  if (!!row.link_tail !== row.link_needs_tail) return null;
  return { name: row.link_name, number: row.link_number, tail: row.link_tail ?? null };
}

/** A pool client inside a transaction, or the pool itself: anything that runs one statement. */
type Runner = { query: <T extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<T>> };

/**
 * The name a new event gets when its organiser chooses none: the name its pod's latest event uses (a series goes on by
 * itself: an organiser names it once), else 'rsn' (the platform's own). Never a name made from the pod's or circle's
 * name: the link is shown to anyone holding it, and the landing never names the pod (call-link.service.ts).
 */
export async function defaultEventLinkName(
  runner: Runner, at: { podId: string | null; exceptSessionId?: string | null },
): Promise<string> {
  if (!at.podId) return EVENT_LINK_DEFAULT_NAME;
  const latest = await runner.query<{ link_name: string }>(
    `SELECT link_name FROM sessions
      WHERE pod_id = $1 AND link_name IS NOT NULL AND id IS DISTINCT FROM $2::uuid
      ORDER BY created_at DESC LIMIT 1`,
    [at.podId, at.exceptSessionId ?? null],
  );
  return latest.rows[0]?.link_name ?? EVENT_LINK_DEFAULT_NAME;
}

const NUMBER_TRIES = 5;

/**
 * The next number under `name`, taken (the counter row stays locked until the caller's transaction ends). A number some
 * event or old link already holds (a counter set back by hand) is passed over, five times at most.
 */
export async function takeEventLinkNumber(client: Runner, name: string): Promise<number> {
  for (let attempt = 0; attempt < NUMBER_TRIES; attempt++) {
    const next = await client.query<{ last_number: number }>(
      `INSERT INTO event_link_counters (name, last_number) VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET last_number = event_link_counters.last_number + 1, updated_at = NOW()
       RETURNING last_number`,
      [name],
    );
    const n = next.rows[0].last_number;
    const held = await client.query(
      `SELECT 1 FROM sessions WHERE link_name = $1 AND link_number = $2
       UNION ALL SELECT 1 FROM event_link_aliases WHERE name = $1 AND number = $2 LIMIT 1`,
      [name, n],
    );
    if (held.rows.length === 0) return n;
  }
  throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, 'We could not make the event link just now. Please try again.');
}

async function keepAsAlias(client: Runner, sessionId: string, parts: EventLinkParts): Promise<void> {
  await client.query(
    `INSERT INTO event_link_aliases (slug, session_id, name, number, secret) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO NOTHING`,
    [eventLinkSlug(parts), sessionId, parts.name, parts.number, parts.tail !== null],
  );
}

/** The event's organisers' cards and pages, told its link changed. Best-effort: a failure never undoes the write. */
async function fanoutEventLink(sessionId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const organisers = await resolveEventOrganiserIds(sessionId);
    await emitEntities(io, organisers, [E.sessionCallLink(sessionId), E.session(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutEventLink: failed to fan out');
  }
}

/**
 * The event's link as it should be now, written when it is not: given the first time (an event made before migration
 * 154 ran, or whose first try failed), renamed to `wantedName` (already checked), given a tail it now needs, or its tail
 * dropped (kept as an alias). Under the event row's lock, so two writers agree. 404 when the event does not exist.
 */
export async function ensureEventLink(sessionId: string, wantedName?: string): Promise<EventLinkParts> {
  if (wantedName === undefined) {
    const now = await query<LinkRow>(LINK_ROW_SQL(false), [sessionId]);
    if (!now.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
    const settled = settledEventLink({ ...now.rows[0], link_needs_tail: now.rows[0].needs_tail });
    if (settled) return settled;
  }
  const outcome = await transaction(async (client) => {
    const locked = await client.query<LinkRow>(LINK_ROW_SQL(true), [sessionId]);
    const row = locked.rows[0];
    if (!row) throw new NotFoundError('Session', sessionId, NOT_FOUND);
    return writeEventLink(client, row, wantedName);
  });
  if (outcome.changed) void fanoutEventLink(sessionId);
  return outcome.parts;
}

async function writeEventLink(
  client: Runner, row: LinkRow, wantedName: string | undefined,
): Promise<{ parts: EventLinkParts; changed: boolean }> {
  const before: EventLinkParts | null = row.link_name && row.link_number
    ? { name: row.link_name, number: row.link_number, tail: row.link_tail }
    : null;
  let parts: EventLinkParts;
  if (!before) {
    const name = wantedName ?? await defaultEventLinkName(client, { podId: row.pod_id, exceptSessionId: row.id });
    parts = { name, number: await takeEventLinkNumber(client, name), tail: row.needs_tail ? newEventLinkTail() : null };
  } else if (wantedName !== undefined && wantedName !== before.name) {
    await keepAsAlias(client, row.id, before);
    // The tail goes with the event (a public one has none: its old tailed link, if any, was just kept above).
    parts = {
      name: wantedName,
      number: await ownOldNumber(client, row.id, wantedName) ?? await takeEventLinkNumber(client, wantedName),
      tail: row.needs_tail ? before.tail : null,
    };
  } else {
    parts = { ...before };
  }
  if (row.needs_tail && !parts.tail) parts.tail = newEventLinkTail();
  if (!row.needs_tail && parts.tail) {
    await keepAsAlias(client, row.id, parts);
    parts.tail = null;
  }
  const changed = !before || before.name !== parts.name || before.number !== parts.number || before.tail !== parts.tail;
  if (changed) {
    await client.query(
      `UPDATE sessions SET link_name = $2, link_number = $3, link_tail = $4 WHERE id = $1`,
      [row.id, parts.name, parts.number, parts.tail],
    );
  }
  return { parts, changed };
}

/** The number the event had under `name` before (its own old link), taken back from the aliases; else null. */
async function ownOldNumber(client: Runner, sessionId: string, name: string): Promise<number | null> {
  const old = await client.query<{ number: number }>(
    `SELECT number FROM event_link_aliases WHERE session_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1`,
    [sessionId, name],
  );
  const number = old.rows[0]?.number;
  if (!number) return null;
  await client.query(`DELETE FROM event_link_aliases WHERE session_id = $1 AND name = $2 AND number = $3`, [sessionId, name, number]);
  return number;
}

/**
 * Part of rotating the call link (inside its transaction): a tailed link gets a new tail, and every old link with a
 * tail is forgotten, so a leaked link stops working. A public link is left as it is.
 */
export async function rotateEventLinkTail(client: Runner, sessionId: string): Promise<void> {
  await client.query(`UPDATE sessions SET link_tail = $2 WHERE id = $1 AND link_tail IS NOT NULL`, [sessionId, newEventLinkTail()]);
  await client.query(`DELETE FROM event_link_aliases WHERE session_id = $1 AND secret`, [sessionId]);
}

/** The event's link for its organisers, given or put right first. */
export async function eventLinkInfo(sessionId: string, opts: { origin?: string } = {}): Promise<EventLinkInfo> {
  const parts = await ensureEventLink(sessionId);
  const slug = eventLinkSlug(parts);
  const path = eventLinkPath(slug);
  return {
    name: parts.name, number: parts.number, slug, path, url: `${eventLinkBaseUrl(opts.origin)}${path}`, private: parts.tail !== null,
  };
}

// ─── The event form's link-name field ─────────────────────────────────────────

/** Who may preview a name: creating, a pod's director or host (createSession's rule); editing, the host (updateSession's). */
async function mayChooseLinkName(actor: Actor, at: { podId?: string; sessionId?: string }): Promise<{
  podId: string | null; circleId: string | null; event: LinkRow | null;
}> {
  const isAdmin = hasRoleAtLeast(actor.role, UserRole.ADMIN);
  if (at.sessionId) {
    const r = await query<LinkRow & { host_user_id: string }>(
      `SELECT s.id, s.pod_id, s.circle_id, s.link_name, s.link_number, s.link_tail, s.host_user_id,
              ${eventLinkNeedsTailSql('s')} AS needs_tail
         FROM sessions s WHERE s.id = $1`,
      [at.sessionId],
    );
    const event = r.rows[0];
    if (!event) throw new NotFoundError('Session', at.sessionId, NOT_FOUND);
    if (!isAdmin && event.host_user_id !== actor.userId) throw new ForbiddenError('Only the host of the event can change it');
    return { podId: event.pod_id, circleId: event.circle_id, event };
  }
  if (!at.podId) throw new ValidationError('Choose the pod first.', { podId: ['Choose the pod first.'] });
  const pod = await query<{ visibility: string }>(`SELECT visibility FROM pods WHERE id = $1`, [at.podId]);
  if (!pod.rows[0]) throw new NotFoundError('Pod', at.podId, "We couldn't find that pod.");
  if (!isAdmin) {
    const role = await query<{ role: string }>(
      `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'`, [at.podId, actor.userId],
    );
    if (!['director', 'host'].includes(role.rows[0]?.role ?? '')) throw new ForbiddenError('Only pod directors and hosts can create events');
  }
  return { podId: at.podId, circleId: null, event: null };
}

/**
 * What the event form shows under its link-name field: the default name, whether the typed one can be used, the number
 * it would most likely get (another event may take it first) and the address without its tail. `visibility` (creating)
 * says whether the link would get a tail; editing, the event itself says.
 */
export async function checkEventLinkName(
  actor: Actor,
  input: { podId?: string; sessionId?: string; circleId?: string; name?: string; visibility?: string },
  opts: { origin?: string } = {},
): Promise<EventLinkNameCheck> {
  const at = await mayChooseLinkName(actor, input);
  const circleId = input.circleId ?? at.circleId;
  const defaultName = at.event?.link_name
    ?? await defaultEventLinkName({ query }, { podId: at.podId, exceptSessionId: input.sessionId });
  const typed = normaliseEventLinkName(input.name ?? '');
  const name = typed || defaultName;
  const problem = eventLinkNameProblem(name);
  const isPrivate = at.event
    ? (isEventVisibility(input.visibility) ? await eventWouldNeedTail(at.event.id, input.visibility) : at.event.needs_tail)
    : await wouldNeedTail(at.podId, circleId, input.visibility);
  if (problem) return { defaultName, name, problem, nextNumber: null, preview: null, private: isPrivate };
  const nextNumber = await likelyNumber(name, at.event);
  return {
    defaultName, name, problem: null, nextNumber, private: isPrivate,
    preview: `${eventLinkBaseUrl(opts.origin)}${eventLinkPath(eventLinkSlug({ name, number: nextNumber, tail: null }))}`,
  };
}

async function likelyNumber(name: string, event: LinkRow | null): Promise<number> {
  if (event && event.link_name === name && event.link_number) return event.link_number;
  if (event) {
    const own = await query<{ number: number }>(
      `SELECT number FROM event_link_aliases WHERE session_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1`,
      [event.id, name],
    );
    if (own.rows[0]) return own.rows[0].number;
  }
  const counter = await query<{ last_number: number }>(`SELECT last_number FROM event_link_counters WHERE name = $1`, [name]);
  return (counter.rows[0]?.last_number ?? 0) + 1;
}

/** Whether this event would need a tail with the visibility its edit form now shows (its admission and circle as stored). */
async function eventWouldNeedTail(sessionId: string, visibility: EventVisibility): Promise<boolean> {
  const r = await query<{ needs_tail: boolean }>(
    `SELECT ${eventLinkNeedsTailSql('s', '$2')} AS needs_tail FROM sessions s WHERE s.id = $1`, [sessionId, visibility],
  );
  return r.rows[0]?.needs_tail ?? true;
}

/**
 * Whether a new event with this visibility in this pod and circle would get a tail. With none sent it follows its pod,
 * except an event for a circle, which createSession makes private.
 */
async function wouldNeedTail(podId: string | null, circleId: string | null, visibility: string | undefined): Promise<boolean> {
  const own: EventVisibility | null = isEventVisibility(visibility) ? visibility : null;
  if (!own && circleId) return true;
  const r = await query<{ needs_tail: boolean }>(
    `SELECT NOT (
       ($3::text IN ('public', 'public_with_approval')
         OR ($3::text IS NULL AND EXISTS (SELECT 1 FROM pods p WHERE p.id = $1 AND p.visibility = 'public')))
       AND NOT EXISTS (SELECT 1 FROM circles c WHERE c.id = $2::uuid AND c.join_policy = 'closed')
     ) AS needs_tail`,
    [podId, circleId, own],
  );
  return r.rows[0]?.needs_tail ?? true;
}
