// ─── Admission per event: modes, allowed emails, one-time codes (Part 2, Task 4, 10 Nov 2026; D3) ───────────
//
// An event's organisers (canActAsHost: its host, co-hosts, the pod's admin, a super admin) choose who gets a place:
// sessions.admission_mode open, approval or restricted ("Invitation only"), with NULL keeping today's rules. The rules
// themselves live in event-access.ts (canRegister, needsApproval, autoRegisters) and session-access.ts (the live-room
// gate); this file keeps the lists those rules read.
//
//   Allowed emails (event_admission_entries): pasted, imported from a CSV, or added one by one; lower-cased, trimmed,
//   once per event. Revoking keeps the row (revoked_at) and adding the address again restores it.
//   Admission codes (event_admission_codes): 12 symbols of Crockford's base 32 (60 bits), shown once as XXXX-XXXX-XXXX
//   and stored only as HMAC-SHA256(server secret, 'admission-code:' + event + ':' + code) with the last four symbols.
//   A code is redeemed by one person, in one guarded UPDATE; the same person redeeming again (a new device) is told
//   it worked, anyone else is refused.
//
// Every write records an audit row (admission.*, recordEventAudit inside the write's own transaction) and tells the organisers
// (session:<id>:admission, and session:<id>:audit once committed).

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import {
  ErrorCodes, defaultEventVisibility,
  type AddAdmissionEmailsResult, type AdmissionCodeRow, type AdmissionEntryRow, type AdmissionMode,
  type EventAdmissionOverview, type GeneratedAdmissionCode, type UserRole,
} from '@rsn/shared';
import config from '../../config';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { fanoutSessionEntities, fanoutSessionListEntities } from '../../realtime/fanout';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { canActAsHost } from '../roles/effective-role.service';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { LIVE_STATUSES } from './main-room';
import { normaliseAdmissionEmail, parseAdmissionCsv } from './admission-csv';

/** The signed-in person a service acts for (the same shape as Part 2's shared Actor, roles/actor.ts). */
export type Actor = { userId: string; role: UserRole };

export const ADMISSION_EMAILS_MAX = 2000;
export const ADMISSION_CODES_MAX = 500;
const INVALID_EXAMPLES_MAX = 50;
const ENTRY_PAGE_DEFAULT = 50;
const ENTRY_PAGE_MAX = 100;
/** The organisers' code list is read whole; four batches of the largest size, and the newest first beyond that. */
const CODE_LIST_MAX = 2000;

/** Crockford's base 32: no I, L, O or U, so a code read aloud or from paper is never ambiguous. */
export const ADMISSION_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ADMISSION_CODE_LENGTH = 12;

export const ADMISSION_LIVE_REFUSAL = "Admission can't change while the event is live.";
export const ADMISSION_TOO_MANY = 'Import at most 2,000 addresses at a time.';
export const ADMISSION_CODE_USED_SENTENCE = 'This admission code has already been used.';
export const ADMISSION_CODE_EXPIRED_SENTENCE = 'This admission code has expired.';
export const ADMISSION_CODE_INVALID_SENTENCE = 'That admission code is not right.';
const ORGANISERS_ONLY = 'Only the people running this event can change who gets in.';
const EVENT_NOT_FOUND = "We couldn't find that event.";

// ─── Telling people ──────────────────────────────────────────────────────────

/**
 * After an admission change has committed: the organisers' admission screens, and (`everyone`) the event's own
 * fan-out plus the named people's event page and lists (an address added or revoked, a code redeemed). Never throws.
 */
export async function fanoutAdmissionChanged(
  sessionId: string,
  opts: { everyone?: boolean; podId?: string | null; people?: string[]; lists?: boolean } = {},
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const organisers = await resolveEventOrganiserIds(sessionId);
    await emitEntities(io, organisers, [E.sessionAdmission(sessionId), E.session(sessionId)]);
    // Every admission write recorded an audit row in its transaction (recordEventAudit with a client never tells).
    await emitEventAuditChanged(sessionId);
    if (opts.everyone) await fanoutSessionEntities(opts.podId ?? null, sessionId, [E.sessionAdmission(sessionId)]);
    for (const userId of new Set(opts.people ?? [])) {
      await emitEntities(io, [userId], [E.session(sessionId), E.userSessions(userId)]);
    }
    if (opts.lists) await fanoutSessionListEntities(opts.podId ?? null, sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutAdmissionChanged: failed to fan out');
  }
}

/** The members whose sign-in address is one of these (an address on a list names a person only through it). */
async function usersWithEmails(emails: string[], client?: PoolClient): Promise<string[]> {
  if (emails.length === 0) return [];
  const sql = `SELECT id FROM users WHERE lower(email) = ANY($1::text[])`;
  const result = client ? await client.query<{ id: string }>(sql, [emails]) : await query<{ id: string }>(sql, [emails]);
  return result.rows.map((r) => r.id);
}

// ─── Who may change it ───────────────────────────────────────────────────────

interface EventRow {
  pod_id: string | null;
  status: string;
  visibility: string | null;
  admission_mode: AdmissionMode | null;
  pod_visibility: string | null;
}

const EVENT_SQL = `SELECT s.pod_id, s.status::text AS status, s.visibility, s.admission_mode, p.visibility::text AS pod_visibility
                     FROM sessions s LEFT JOIN pods p ON p.id = s.pod_id
                    WHERE s.id = $1`;

/** The event, when the actor organises it: 404 for no event, 403 for someone who does not run it. */
async function requireOrganiser(sessionId: string, actor: Actor): Promise<EventRow> {
  const result = await query<EventRow>(EVENT_SQL, [sessionId]);
  const event = result.rows[0];
  if (!event) throw new NotFoundError('Session', sessionId, EVENT_NOT_FOUND);
  const { allowed } = await canActAsHost(actor.userId, actor.role, sessionId);
  if (!allowed) throw new ForbiddenError(ORGANISERS_ONLY);
  return event;
}

const isLive = (status: string) => (LIVE_STATUSES as readonly string[]).includes(status);

// ─── The mode ────────────────────────────────────────────────────────────────

/** GET /sessions/:id/admission: the mode, what decides a place, and the counts the organisers' card shows. */
export async function getAdmissionOverview(sessionId: string, actor: Actor): Promise<EventAdmissionOverview> {
  const event = await requireOrganiser(sessionId, actor);
  const counts = await query<{ listed: number; registered: number; codes_unused: number; codes_used: number }>(
    `SELECT (SELECT COUNT(*)::int FROM event_admission_entries e WHERE e.session_id = $1 AND e.revoked_at IS NULL) AS listed,
            (SELECT COUNT(*)::int FROM event_admission_entries e
               JOIN users u ON lower(u.email) = e.email
               JOIN session_participants sp ON sp.session_id = e.session_id AND sp.user_id = u.id
              WHERE e.session_id = $1 AND e.revoked_at IS NULL AND sp.status NOT IN ('removed', 'left')) AS registered,
            (SELECT COUNT(*)::int FROM event_admission_codes c
              WHERE c.session_id = $1 AND c.redeemed_at IS NULL AND c.revoked_at IS NULL
                AND (c.expires_at IS NULL OR c.expires_at > NOW())) AS codes_unused,
            (SELECT COUNT(*)::int FROM event_admission_codes c WHERE c.session_id = $1 AND c.redeemed_at IS NOT NULL) AS codes_used`,
    [sessionId],
  );
  const c = counts.rows[0];
  const mode = event.admission_mode ?? null;
  return {
    mode,
    effective: mode ?? (event.visibility === null ? 'pod_rules' : 'members_only'),
    counts: { listed: c?.listed ?? 0, registered: c?.registered ?? 0, codesUnused: c?.codes_unused ?? 0, codesUsed: c?.codes_used ?? 0 },
  };
}

/**
 * Set (or clear, with null) who gets a place. On an event that follows its pod (no visibility) a mode also gives it
 * the pod's default visibility in the same write (D3), so a mode never sits on a NULL event. Refused while live.
 */
export async function setAdmissionMode(sessionId: string, actor: Actor, mode: AdmissionMode | null): Promise<void> {
  await requireOrganiser(sessionId, actor);
  const outcome = await transaction(async (client) => {
    const locked = await client.query<EventRow>(`${EVENT_SQL} FOR UPDATE OF s`, [sessionId]);
    const event = locked.rows[0];
    if (!event) throw new NotFoundError('Session', sessionId, EVENT_NOT_FOUND);
    if (isLive(event.status)) throw new ConflictError(ErrorCodes.SESSION_IN_PROGRESS, ADMISSION_LIVE_REFUSAL);
    if ((event.admission_mode ?? null) === mode) return null;
    const visibility = mode && !event.visibility ? defaultEventVisibility(event.pod_visibility) : null;
    await client.query(
      `UPDATE sessions SET admission_mode = $2, visibility = COALESCE(visibility, $3::text) WHERE id = $1`,
      [sessionId, mode, visibility],
    );
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'admission.mode_changed', automatic: false,
      before: { mode: event.admission_mode ?? null, visibility: event.visibility },
      after: { mode, visibility: event.visibility ?? visibility },
    }, client);
    return { podId: event.pod_id, visibilityChanged: visibility !== null };
  });
  if (outcome) {
    await fanoutAdmissionChanged(sessionId, { everyone: true, podId: outcome.podId, lists: outcome.visibilityChanged });
  }
}

// ─── Allowed emails ──────────────────────────────────────────────────────────

/**
 * Add addresses (pasted, from a CSV, or one by an organiser). At most 2,000 distinct addresses per call; each is trimmed
 * and lower-cased and counted once. A new address is added, a revoked one restored, a listed one left as it is.
 * `invalid` holds up to 50 examples of what could not be an address (a CSV row is named by its number).
 */
export async function addAdmissionEmails(
  sessionId: string,
  actor: Actor,
  input: { emails?: string[]; csv?: string; groupKey?: string | null; source: 'paste' | 'csv' | 'organiser' },
): Promise<AddAdmissionEmailsResult> {
  const event = await requireOrganiser(sessionId, actor);
  const wanted: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const take = (email: string) => { if (!seen.has(email)) { seen.add(email); wanted.push(email); } };
  for (const raw of input.emails ?? []) {
    if (raw.trim() === '') continue;
    const email = normaliseAdmissionEmail(raw);
    if (email) take(email);
    else if (invalid.length < INVALID_EXAMPLES_MAX) invalid.push(raw.trim().slice(0, 255));
  }
  if (input.csv !== undefined) {
    const parsed = parseAdmissionCsv(input.csv);
    parsed.emails.forEach(take);
    for (const row of parsed.invalidRows) {
      if (invalid.length >= INVALID_EXAMPLES_MAX) break;
      invalid.push(`Row ${row}`);
    }
  }
  if (wanted.length > ADMISSION_EMAILS_MAX) throw new ValidationError(ADMISSION_TOO_MANY);
  if (wanted.length === 0) return { added: 0, alreadyListed: 0, restored: 0, invalid };

  const groupKey = input.groupKey ?? null;
  const counted = await transaction(async (client) => {
    const restored = await client.query<{ email: string }>(
      `UPDATE event_admission_entries
          SET revoked_at = NULL, revoked_by = NULL, source = $3, added_by = $4, group_key = COALESCE($5, group_key)
        WHERE session_id = $1 AND email = ANY($2::text[]) AND revoked_at IS NOT NULL
        RETURNING email`,
      [sessionId, wanted, input.source, actor.userId, groupKey],
    );
    const added = await client.query<{ email: string }>(
      `INSERT INTO event_admission_entries (session_id, email, group_key, source, added_by)
       SELECT $1, e.email, $3, $4, $5 FROM unnest($2::text[]) AS e(email)
       ON CONFLICT (session_id, email) DO NOTHING
       RETURNING email`,
      [sessionId, wanted, groupKey, input.source, actor.userId],
    );
    const changed = [...restored.rows, ...added.rows].map((r) => r.email);
    const result = {
      added: added.rows.length,
      restored: restored.rows.length,
      alreadyListed: wanted.length - added.rows.length - restored.rows.length,
    };
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'admission.emails_added', automatic: false,
      after: { ...result, source: input.source, groupKey },
    }, client);
    return { ...result, people: await usersWithEmails(changed, client) };
  });
  await fanoutAdmissionChanged(sessionId, { everyone: true, podId: event.pod_id, people: counted.people });
  return { added: counted.added, alreadyListed: counted.alreadyListed, restored: counted.restored, invalid };
}

/**
 * Take an address off the list. Its person keeps any place they hold, but an invitation-only event lets them neither
 * register again nor into its live room (the gate re-checks on every join). Revoking it again changes nothing.
 */
export async function revokeAdmissionEmail(sessionId: string, actor: Actor, entryId: string): Promise<void> {
  const event = await requireOrganiser(sessionId, actor);
  const people = await transaction(async (client) => {
    const result = await client.query<{ email: string }>(
      `UPDATE event_admission_entries SET revoked_at = NOW(), revoked_by = $3
        WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
        RETURNING email`,
      [entryId, sessionId, actor.userId],
    );
    const row = result.rows[0];
    if (!row) {
      const exists = await client.query(`SELECT 1 FROM event_admission_entries WHERE id = $1 AND session_id = $2`, [entryId, sessionId]);
      if (exists.rows.length === 0) throw new AppError(404, ErrorCodes.ADMISSION_ENTRY_NOT_FOUND, "We couldn't find that address on the list.");
      return null;
    }
    const subjects = await usersWithEmails([row.email], client);
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'admission.email_revoked', automatic: false,
      subjectUserIds: subjects, before: { entryId },
    }, client);
    return subjects;
  });
  if (people) await fanoutAdmissionChanged(sessionId, { everyone: true, podId: event.pod_id, people });
}

/** The organisers' list of allowed emails, by address, a page at a time; `q` keeps addresses that contain it. */
export async function listAdmissionEntries(
  sessionId: string,
  actor: Actor,
  opts: { q?: string; cursor?: string; limit?: number } = {},
): Promise<{ entries: AdmissionEntryRow[]; nextCursor: string | null }> {
  await requireOrganiser(sessionId, actor);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? ENTRY_PAGE_DEFAULT), 1), ENTRY_PAGE_MAX);
  const q = opts.q?.trim().toLowerCase() || null;
  const result = await query<{
    id: string; email: string; group_key: string | null; revoked: boolean; registered: boolean; display_name: string | null;
  }>(
    `SELECT e.id, e.email, e.group_key, e.revoked_at IS NOT NULL AS revoked,
            EXISTS (SELECT 1 FROM users ru JOIN session_participants sp ON sp.user_id = ru.id
                     WHERE lower(ru.email) = e.email AND sp.session_id = e.session_id
                       AND sp.status NOT IN ('removed', 'left')) AS registered,
            (SELECT du.display_name FROM users du WHERE lower(du.email) = e.email LIMIT 1) AS display_name
       FROM event_admission_entries e
      WHERE e.session_id = $1
        AND ($2::text IS NULL OR position($2::text in e.email) > 0)
        AND ($3::text IS NULL OR e.email > $3::text)
      ORDER BY e.email
      LIMIT $4`,
    [sessionId, q, opts.cursor ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  return {
    entries: page.map((r) => ({
      id: r.id,
      email: r.email,
      groupKey: r.group_key,
      status: r.revoked ? 'revoked' : r.registered ? 'registered' : 'listed',
      displayName: r.display_name,
    })),
    nextCursor: result.rows.length > limit ? page[page.length - 1].email : null,
  };
}

// ─── Admission codes ─────────────────────────────────────────────────────────

/** A new code's 12 symbols, each drawn with crypto.randomInt (60 bits in all). */
export function newAdmissionCode(): string {
  let code = '';
  for (let i = 0; i < ADMISSION_CODE_LENGTH; i++) code += ADMISSION_CODE_ALPHABET[crypto.randomInt(ADMISSION_CODE_ALPHABET.length)];
  return code;
}

/** XXXX-XXXX-XXXX, as an organiser hands it out. */
export function formatAdmissionCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/**
 * A typed code as it was generated, or null when it cannot be one: upper-cased, spaces and dashes dropped, and the
 * letters Crockford's alphabet leaves out read as the digits they look like (O as 0, I and L as 1).
 */
export function normaliseAdmissionCode(raw: string): string | null {
  let code = '';
  for (const ch of raw.toUpperCase()) {
    if (ch === ' ' || ch === '-' || ch === '\t') continue;
    const read = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch;
    if (!ADMISSION_CODE_ALPHABET.includes(read)) return null;
    code += read;
    if (code.length > ADMISSION_CODE_LENGTH) return null;
  }
  return code.length === ADMISSION_CODE_LENGTH ? code : null;
}

/** What is stored for a code: keyed by the server's secret and bound to its event. */
export function hashAdmissionCode(sessionId: string, normalised: string): string {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`admission-code:${sessionId.toLowerCase()}:${normalised}`)
    .digest('hex');
}

/** Make 1 to 500 codes. Their plaintext is in this answer and nowhere else, ever. */
export async function generateAdmissionCodes(
  sessionId: string,
  actor: Actor,
  input: { count: number; label?: string; groupKey?: string | null; expiresAt?: string | null },
): Promise<{ codes: GeneratedAdmissionCode[] }> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > ADMISSION_CODES_MAX) {
    throw new ValidationError('Make between 1 and 500 codes at a time.');
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw new ValidationError('Choose an expiry in the future.');
  }
  await requireOrganiser(sessionId, actor);
  const label = input.label?.trim() || null;
  const groupKey = input.groupKey ?? null;

  const codes = await transaction(async (client) => {
    const made: GeneratedAdmissionCode[] = [];
    // A clash (the same 60-bit code twice in one event) is never expected; a few rounds absorb one anyway.
    for (let round = 0; round < 3 && made.length < input.count; round++) {
      const plain = new Map<string, string>();
      while (plain.size < input.count - made.length) {
        const code = newAdmissionCode();
        plain.set(hashAdmissionCode(sessionId, code), code);
      }
      const hashes = [...plain.keys()];
      const inserted = await client.query<{ id: string; code_hash: string }>(
        `INSERT INTO event_admission_codes (session_id, code_hash, code_last4, label, group_key, created_by, expires_at)
         SELECT $1, h.code_hash, h.last4, $4, $5, $6, $7 FROM unnest($2::text[], $3::text[]) AS h(code_hash, last4)
         ON CONFLICT (session_id, code_hash) DO NOTHING
         RETURNING id, code_hash`,
        [sessionId, hashes, hashes.map((h) => plain.get(h)!.slice(-4)), label, groupKey, actor.userId, expiresAt],
      );
      for (const row of inserted.rows) made.push({ id: row.id, code: formatAdmissionCode(plain.get(row.code_hash)!) });
    }
    if (made.length < input.count) throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Admission codes could not be made. Please try again.');
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'admission.codes_generated', automatic: false,
      after: { count: made.length, label, groupKey, expiresAt: expiresAt?.toISOString() ?? null },
    }, client);
    return made;
  });
  await fanoutAdmissionChanged(sessionId);
  return { codes };
}

/** The organisers' list of codes, newest first: never a code, only its last four symbols and what became of it. */
export async function listAdmissionCodes(sessionId: string, actor: Actor): Promise<AdmissionCodeRow[]> {
  await requireOrganiser(sessionId, actor);
  const result = await query<{
    id: string; last4: string; label: string | null; group_key: string | null;
    revoked: boolean; used: boolean; expired: boolean; redeemer_id: string | null; redeemer_name: string | null;
  }>(
    `SELECT c.id, c.code_last4 AS last4, c.label, c.group_key,
            c.revoked_at IS NOT NULL AS revoked, c.redeemed_at IS NOT NULL AS used,
            (c.expires_at IS NOT NULL AND c.expires_at <= NOW()) AS expired,
            c.redeemed_by AS redeemer_id, u.display_name AS redeemer_name
       FROM event_admission_codes c
       LEFT JOIN users u ON u.id = c.redeemed_by
      WHERE c.session_id = $1
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $2`,
    [sessionId, CODE_LIST_MAX],
  );
  return result.rows.map((r) => ({
    id: r.id,
    last4: r.last4,
    label: r.label,
    groupKey: r.group_key,
    status: r.revoked ? 'revoked' : r.used ? 'used' : r.expired ? 'expired' : 'unused',
    redeemedBy: r.redeemer_id ? { id: r.redeemer_id, displayName: r.redeemer_name ?? 'Former member' } : null,
  }));
}

/** Revoke a code: unused, it can no longer be redeemed; redeemed, its person loses the entitlement it gave. */
export async function revokeAdmissionCode(sessionId: string, actor: Actor, codeId: string): Promise<void> {
  const event = await requireOrganiser(sessionId, actor);
  const outcome = await transaction(async (client) => {
    const result = await client.query<{ redeemed_by: string | null }>(
      `UPDATE event_admission_codes SET revoked_at = NOW()
        WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
        RETURNING redeemed_by`,
      [codeId, sessionId],
    );
    const row = result.rows[0];
    if (!row) {
      const exists = await client.query(`SELECT 1 FROM event_admission_codes WHERE id = $1 AND session_id = $2`, [codeId, sessionId]);
      if (exists.rows.length === 0) throw new AppError(404, ErrorCodes.ADMISSION_CODE_NOT_FOUND, "We couldn't find that admission code.");
      return null;
    }
    const subjects = row.redeemed_by ? [row.redeemed_by] : [];
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'admission.code_revoked', automatic: false,
      subjectUserIds: subjects, before: { codeId },
    }, client);
    return subjects;
  });
  if (outcome) await fanoutAdmissionChanged(sessionId, { everyone: outcome.length > 0, podId: event.pod_id, people: outcome });
}

/**
 * Redeem a code for `userId` (any signed-in person: a member, or a guest from the event's link). One guarded UPDATE
 * claims it, so two people at once never both win. The same person again (a new device) gets the code back; someone
 * else's code is 409 ADMISSION_CODE_USED; a code past its expiry 400 ADMISSION_CODE_EXPIRED; anything else (a typo, a
 * revoked code, another event's code, an event that does not exist) one identical 400 ADMISSION_CODE_INVALID.
 * With `client` it is part of the caller's transaction and the caller tells the screens (fanoutAdmissionChanged) after
 * its commit; without one it commits and tells them itself.
 */
export async function redeemAdmissionCode(
  sessionId: string,
  userId: string,
  raw: string,
  client?: PoolClient,
): Promise<{ codeId: string; groupKey: string | null }> {
  const normalised = normaliseAdmissionCode(raw);
  if (!normalised) throw new AppError(400, ErrorCodes.ADMISSION_CODE_INVALID, ADMISSION_CODE_INVALID_SENTENCE);
  const codeHash = hashAdmissionCode(sessionId, normalised);
  const run = async (c: PoolClient) => {
    const claimed = await c.query<{ id: string; group_key: string | null }>(
      `UPDATE event_admission_codes SET redeemed_by = $3, redeemed_at = NOW()
        WHERE session_id = $1 AND code_hash = $2
          AND redeemed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id, group_key`,
      [sessionId, codeHash, userId],
    );
    if (claimed.rows[0]) {
      await recordEventAudit({
        sessionId, actorId: userId, action: 'admission.code_redeemed', automatic: false,
        subjectUserIds: [userId], after: { codeId: claimed.rows[0].id },
      }, c);
      return { codeId: claimed.rows[0].id, groupKey: claimed.rows[0].group_key, fresh: true };
    }
    const found = await c.query<{ id: string; group_key: string | null; redeemed_by: string | null; revoked: boolean; expired: boolean }>(
      `SELECT id, group_key, redeemed_by, revoked_at IS NOT NULL AS revoked,
              (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
         FROM event_admission_codes WHERE session_id = $1 AND code_hash = $2`,
      [sessionId, codeHash],
    );
    const code = found.rows[0];
    if (!code || code.revoked) throw new AppError(400, ErrorCodes.ADMISSION_CODE_INVALID, ADMISSION_CODE_INVALID_SENTENCE);
    if (code.redeemed_by === userId) return { codeId: code.id, groupKey: code.group_key, fresh: false };
    if (code.redeemed_by) throw new ConflictError(ErrorCodes.ADMISSION_CODE_USED, ADMISSION_CODE_USED_SENTENCE);
    if (code.expired) throw new AppError(400, ErrorCodes.ADMISSION_CODE_EXPIRED, ADMISSION_CODE_EXPIRED_SENTENCE);
    // Unclaimed, unrevoked and unexpired, yet the claim missed: someone else claimed it in between. Read it as used.
    throw new ConflictError(ErrorCodes.ADMISSION_CODE_USED, ADMISSION_CODE_USED_SENTENCE);
  };
  if (client) {
    const outcome = await run(client);
    return { codeId: outcome.codeId, groupKey: outcome.groupKey };
  }
  const outcome = await transaction(run);
  if (outcome.fresh) {
    const event = await query<{ pod_id: string | null }>(`SELECT pod_id FROM sessions WHERE id = $1`, [sessionId]);
    await fanoutAdmissionChanged(sessionId, { everyone: true, podId: event.rows[0]?.pod_id ?? null, people: [userId] });
  }
  return { codeId: outcome.codeId, groupKey: outcome.groupKey };
}
