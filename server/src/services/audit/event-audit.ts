// ─── Event audit trail (Part 2 foundation, Task 1) ───────────────────────────
//
// Who did what to an event, and whether the product did it by itself. Rows go into `audit_log`
// (entity_type = 'session', entity_id = the event), which is kept forever and has no foreign key on
// entity_id, so the trail survives the event's permanent delete. The REST middleware (middleware/audit.ts)
// writes its own 'session:*' rows beside these; this module only reads and writes the dotted actions below.
//
// recordEventAudit has two shapes:
//   - with a `client` it is part of the caller's transaction and throws, so a mutation and its audit row
//     stand or fall together. The realtime tag is NOT sent here (the transaction has not committed yet):
//     call emitEventAuditChanged once it has.
//   - without a client it is fire-and-forget: a failed write is logged and never thrown, so a live socket
//     path cannot fail on an audit write. It tells the organisers' screens straight away.

import type { PoolClient } from 'pg';
import logger from '../../config/logger';
import { query } from '../../db';
import { ValidationError } from '../../middleware/errors';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { FORMER_MEMBER_NAME } from '../users/active-member';

export const EVENT_AUDIT_ACTIONS = [
  'event.published', 'event.unpublished', 'event.started', 'event.completed', 'event.cancelled',
  'event.archived', 'event.unarchived', 'event.deleted',
  'admission.mode_changed', 'admission.request_approved', 'admission.request_declined',
  'admission.emails_added', 'admission.email_revoked', 'admission.codes_generated',
  'admission.code_revoked', 'admission.code_redeemed',
  'group.rules_changed', 'group.assigned',
  'match.preview_generated', 'match.regenerated', 'match.swapped', 'match.excluded', 'match.moved',
  'match.round_announced', 'match.round_confirmed', 'match.preview_cancelled', 'match.repaired', 'match.override',
  'participant.removed', 'breakout.created',
  'schedule.generated', 'schedule.edited', 'schedule.locked', 'schedule.unlocked', 'schedule.published',
] as const;

export type EventAuditAction = typeof EVENT_AUDIT_ACTIONS[number];

export interface EventAuditEntry {
  sessionId: string;
  actorId: string | null;
  action: EventAuditAction;
  automatic: boolean;
  scheduleVersion?: number | null;
  round?: number | null;
  subjectUserIds?: string[];
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface EventAuditPerson { id: string; displayName: string }

export interface EventAuditRow {
  id: string;
  at: string;
  actor: EventAuditPerson | null;
  automatic: boolean;
  action: EventAuditAction;
  round: number | null;
  scheduleVersion: number | null;
  subjects: EventAuditPerson[];
  reason: string | null;
}

/** The most a row's details may weigh, in characters of JSON. Beyond it before/after are replaced. */
export const EVENT_AUDIT_DETAILS_CAP = 16 * 1024;
/** Subjects kept on one row when even the trimmed details are too big (a bulk action names many people). */
const SUBJECTS_KEPT_WHEN_OVER_CAP = 200;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuditDetails {
  automatic: boolean;
  scheduleVersion: number | null;
  round: number | null;
  subjectUserIds: string[];
  before: unknown;
  after: unknown;
  reason: string | null;
}

/** The details as stored: within the cap, with before/after reduced to `{ truncated: true }` when they are what made it big. */
export function buildAuditDetails(entry: EventAuditEntry): AuditDetails {
  const details: AuditDetails = {
    automatic: entry.automatic,
    scheduleVersion: entry.scheduleVersion ?? null,
    round: entry.round ?? null,
    subjectUserIds: entry.subjectUserIds ?? [],
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  };
  if (JSON.stringify(details).length <= EVENT_AUDIT_DETAILS_CAP) return details;
  const trimmed: AuditDetails = {
    ...details,
    before: details.before === null ? null : { truncated: true },
    after: details.after === null ? null : { truncated: true },
  };
  if (JSON.stringify(trimmed).length <= EVENT_AUDIT_DETAILS_CAP) return trimmed;
  return {
    ...trimmed,
    subjectUserIds: trimmed.subjectUserIds.slice(0, SUBJECTS_KEPT_WHEN_OVER_CAP),
    reason: trimmed.reason === null ? null : trimmed.reason.slice(0, 500),
  };
}

/** Tells the event's host and co-hosts that its audit trail changed. Never throws. */
export async function emitEventAuditChanged(sessionId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const result = await query<{ user_id: string }>(
      `SELECT host_user_id AS user_id FROM sessions WHERE id = $1 AND host_user_id IS NOT NULL
       UNION
       SELECT user_id FROM session_cohosts WHERE session_id = $1`,
      [sessionId],
    );
    await emitEntities(io, result.rows.map((r) => r.user_id), [E.sessionAudit(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'emitEventAuditChanged: failed to fan out');
  }
}

const INSERT_SQL = `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
                    VALUES ($1, $2, 'session', $3, $4::jsonb)`;

function insertParams(entry: EventAuditEntry): unknown[] {
  return [entry.actorId, entry.action, entry.sessionId, JSON.stringify(buildAuditDetails(entry))];
}

export async function recordEventAudit(entry: EventAuditEntry, client?: PoolClient): Promise<void> {
  if (client) {
    await client.query(INSERT_SQL, insertParams(entry));
    return;
  }
  try {
    // Building the details is inside the try too: a payload that cannot be stringified (circular, BigInt) is logged,
    // never a rejection nobody awaits at a `void recordEventAudit(...)` call site.
    await query(INSERT_SQL, insertParams(entry));
  } catch (err) {
    logger.error({ err, sessionId: entry.sessionId, action: entry.action }, 'Failed to record event audit entry');
    return;
  }
  await emitEventAuditChanged(entry.sessionId);
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** `<UTC timestamp to the microsecond>|<row id>`: the pair the list is ordered by. */
const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/i;

export function isEventAuditCursor(value: string): boolean {
  return CURSOR.test(value) && UUID.test(value.split('|')[1]);
}

interface AuditQueryRow {
  id: string;
  at: string;
  cursor_ts: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_active: boolean | null;
  action: EventAuditAction;
  details: Partial<AuditDetails> | null;
}

export async function listEventAudit(
  sessionId: string,
  opts: { cursor?: string; limit?: number },
): Promise<{ entries: EventAuditRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
  const params: unknown[] = [sessionId, [...EVENT_AUDIT_ACTIONS]];
  let after = '';
  if (opts.cursor !== undefined) {
    if (!isEventAuditCursor(opts.cursor)) throw new ValidationError('That page of the history could not be found.');
    const [ts, id] = opts.cursor.split('|');
    params.push(ts, id.toLowerCase());
    after = 'AND (a.created_at, a.id) < ($3::timestamptz, $4::uuid)';
  }
  params.push(limit + 1);

  const result = await query<AuditQueryRow>(
    `SELECT a.id, a.created_at AS at,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
            a.actor_id, u.display_name AS actor_name, (u.status = 'active') AS actor_active,
            a.action, a.details
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity_type = 'session' AND a.entity_id = $1 AND a.action = ANY($2::text[])
        ${after}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const page = hasMore ? result.rows.slice(0, limit) : result.rows;

  const subjectIds = new Set<string>();
  for (const row of page) {
    for (const id of row.details?.subjectUserIds ?? []) {
      if (typeof id === 'string' && UUID.test(id)) subjectIds.add(id);
    }
  }
  const people = new Map<string, EventAuditPerson>();
  if (subjectIds.size > 0) {
    const found = await query<{ id: string; display_name: string | null; active: boolean }>(
      `SELECT id, display_name, (status = 'active') AS active FROM users WHERE id = ANY($1::uuid[])`,
      [[...subjectIds]],
    );
    for (const u of found.rows) {
      people.set(u.id, { id: u.id, displayName: u.active && u.display_name ? u.display_name : FORMER_MEMBER_NAME });
    }
  }

  const entries = page.map((row): EventAuditRow => {
    const d = row.details ?? {};
    const actor: EventAuditPerson | null = row.actor_id
      ? { id: row.actor_id, displayName: row.actor_active && row.actor_name ? row.actor_name : FORMER_MEMBER_NAME }
      : null;
    const subjects = (d.subjectUserIds ?? [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => people.get(id) ?? { id, displayName: FORMER_MEMBER_NAME });
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      actor,
      automatic: d.automatic === true,
      action: row.action,
      round: typeof d.round === 'number' ? d.round : null,
      scheduleVersion: typeof d.scheduleVersion === 'number' ? d.scheduleVersion : null,
      subjects,
      reason: typeof d.reason === 'string' ? d.reason : null,
    };
  });

  const last = page[page.length - 1];
  return { entries, nextCursor: hasMore && last ? `${last.cursor_ts}|${last.id}` : null };
}
