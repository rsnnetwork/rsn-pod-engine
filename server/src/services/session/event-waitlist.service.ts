// ─── An event's waiting list (10 Nov 2026 spec, Part 3 Task 3; plan K3) ──────────────────────────────────
//
// An event is full when every place it has (sessions.config.maxParticipants) is held by someone other than its host
// and co-hosts (capacityTakenSql). Someone who may take a place but finds it full joins the waiting list instead, and
// the first in line is given the next place that frees, with a bell and an email.
//
//   - The line is its own table (event_waitlist), never a participant status: a waiting person is matched, admitted to
//     the live room, reminded, counted, listed as a participant and offered DMs nowhere (Review Focus #2).
//   - One advisory lock per event (lockEventCapacity) is held around every new place and every promotion, so there are
//     never more holders than places and the line is strictly first in, first out (Review Focus #1).
//   - A promotion re-runs every rule (registerParticipantTx), so someone who no longer qualifies (their entitlement
//     revoked, their account closed, a removal) lapses and the next person is promoted.
//   - Only deliberate acts free a place (afterPlaceFreed's causes): unregistering, an organiser removing someone, being
//     made a co-host, a capacity raised, an account closed or suspended. left, disconnected and no_show keep their
//     place. Promotion carries on while the event is live; a completed, cancelled or draft event promotes nobody.
//
// Controller rulings (11 Nov 2026), held here:
//   - No environment switch. The REST register answers 409 SESSION_FULL on a full event exactly as before unless its body
//     asks for the line (`waitlist: true`), so production's client behaves as today. The RSN Call link's enterCall, an
//     approval on a full event and an invite accepted on a full event queue the person by themselves (new paths, or a
//     dead end made a line).
//   - Attendees are never told counts, only "full". The promotion email is transactional: it ignores notify_email and is
//     gated by the admin switch 'event_waitlist_promoted' alone.

import type { PoolClient } from 'pg';
import {
  ErrorCodes, callLinkPath, formatEventTime, relativeEventTime,
  type SessionParticipant, type UserRole, type WaitlistEntryCard, type WaitlistJoinedVia,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { fanoutSessionEntities } from '../../realtime/fanout';
import { activeMemberSql } from '../users/active-member';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import * as emailService from '../email/email.service';
import { buildSessionCalendarEvent } from '../calendar/calendar.service';
import type { Actor } from '../roles/actor';
import {
  capacityTakenSql, eventCapacitySql, managesRequests, readEventAccessFacts, waitlistPositionSql,
} from './event-access';
import { checkRegistrationGroups } from './event-groups.service';
import { ensureCallCode } from './call-link.service';
import { isLiveStatus } from './main-room';
import { ringEventBells } from './event-notices';
import {
  lineStalled, lockEventCapacity, registerParticipantTx, syncLiveRegistration,
  type RegisterOptions, type RegisterTxOptions,
} from './session.service';

/** Where a registration that may queue ends: a place, or a place in the line (1 = next). */
export type PlaceOutcome =
  | { kind: 'registered'; participant: SessionParticipant; isNewRegistration: boolean }
  | { kind: 'waitlisted'; position: number; isNew: boolean };

/** What freed a place (afterPlaceFreed): only deliberate acts do. */
export type PlaceFreedCause = 'unregister' | 'removed' | 'cohost' | 'capacity' | 'account' | 'stalled';

/** The most people the organisers' list shows, and the most one promotion pass gives a place to. */
export const WAITLIST_LIST_MAX = 500;

const NOT_FOUND = "We couldn't find that event.";
const NOT_ORGANISER = 'Only the people running this event can manage its waiting list.';
const NOT_WAITING = 'That person is not on this event\'s waiting list.';
const TAKEN_OFF = 'The organisers have taken you off this event\'s waiting list.';

// ─── Joining, reading and leaving the line ───────────────────────────────────

/**
 * The person's place in the event's waiting list (1 = next), or null when they are not waiting. Someone ahead whose
 * account is no longer active is not counted.
 */
export async function waitlistPosition(sessionId: string, userId: string, client?: PoolClient): Promise<number | null> {
  const run = client ? client.query.bind(client) : query;
  const r = await run<{ position: number | string | null }>(
    `SELECT ${waitlistPositionSql('s', '$2')} AS position FROM sessions s WHERE s.id = $1`,
    [sessionId, userId],
  );
  const position = r.rows[0]?.position;
  return position === null || position === undefined ? null : Number(position);
}

/**
 * Join the line, inside the capacity lock (registerOrWaitlist is the only caller). Idempotent: someone already waiting
 * keeps their place. Someone who left the line, lapsed, or was promoted and has since given the place up joins again at
 * the back. Someone the organisers took off the line stays off it (they may still register when a place is free).
 */
export async function joinWaitlist(
  client: PoolClient,
  sessionId: string,
  userId: string,
  input: { joinedVia: WaitlistJoinedVia; groupKeys?: string[] },
): Promise<{ position: number; isNew: boolean }> {
  const written = await client.query<{ id: string }>(
    `INSERT INTO event_waitlist (session_id, user_id, joined_via, group_keys)
     VALUES ($1, $2, $3, $4::text[])
     ON CONFLICT (session_id, user_id) DO UPDATE
        SET status = 'waiting', joined_via = EXCLUDED.joined_via, group_keys = EXCLUDED.group_keys,
            lapsed_reason = NULL, queued_at = NOW(), decided_at = NULL, decided_by = NULL, updated_at = NOW()
      WHERE event_waitlist.status IN ('left', 'lapsed', 'promoted')
     RETURNING id`,
    [sessionId, userId, input.joinedVia, input.groupKeys ?? []],
  );
  const isNew = (written.rowCount ?? 0) > 0;
  if (!isNew) {
    const held = await client.query<{ status: string }>(
      `SELECT status FROM event_waitlist WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (held.rows[0]?.status === 'removed') throw new ForbiddenError(TAKEN_OFF);
  }
  const position = await waitlistPosition(sessionId, userId, client);
  // A row just written or found waiting always has a position; 1 is the floor should the account read as inactive.
  return { position: position ?? 1, isNew };
}

/**
 * registerParticipant, but a full event puts the person on its waiting list instead of answering 409 SESSION_FULL.
 * The capacity lock is taken first and held to commit, so "full, then a place frees before I queue" cannot happen; the
 * registration runs under a savepoint taken after it (rolling back to the savepoint undoes the registration's own
 * writes, a public pod's auto-add included, and keeps the lock). Then the person's group answer is checked without
 * writing it (it is kept on the waiting row and written when they are promoted), and they join the line.
 */
export async function registerOrWaitlist(
  sessionId: string,
  userId: string,
  role: UserRole | undefined,
  options: RegisterOptions & { joinedVia: WaitlistJoinedVia },
): Promise<PlaceOutcome> {
  const { joinedVia, ...registerOptions } = options;
  // Fix round 1 (review I-1): the recount found people waiting while a place is free; the line is moved on below.
  let stalled = false;
  const onLineStalled = () => { stalled = true; };
  let outcome: PlaceOutcome;
  try {
    outcome = await transaction<PlaceOutcome>((client) => placeOrQueue(client, sessionId, userId, role, joinedVia, {
      ...registerOptions, onLineStalled,
    }));
  } finally {
    if (stalled) lineStalled(sessionId);
  }

  if (outcome.kind === 'registered') {
    await syncLiveRegistration(sessionId, userId);
  } else if (outcome.isNew) {
    void emitEventAuditChanged(sessionId);
    void emitWaitlistChanged(sessionId, [userId]);
  }
  return outcome;
}

/** registerOrWaitlist's transaction: the lock, then the registration under a savepoint, else the line. */
async function placeOrQueue(
  client: PoolClient, sessionId: string, userId: string, role: UserRole | undefined, joinedVia: WaitlistJoinedVia,
  registerOptions: RegisterTxOptions,
): Promise<PlaceOutcome> {
  await lockEventCapacity(client, sessionId);
  await client.query('SAVEPOINT before_place');
  try {
    const participant = await registerParticipantTx(client, sessionId, userId, role, registerOptions);
    await client.query('RELEASE SAVEPOINT before_place');
    const { isNewRegistration, ...row } = participant;
    return { kind: 'registered', participant: row, isNewRegistration };
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== ErrorCodes.SESSION_FULL) throw err;
    // Fix round 1 (review M-3): rolled back to, then released, so no savepoint is left nested.
    await client.query('ROLLBACK TO SAVEPOINT before_place');
    await client.query('RELEASE SAVEPOINT before_place');
    const viaInvite = !!registerOptions.viaInvite || !!registerOptions.personalInviteCreatedAt;
    const groupKeys = await checkRegistrationGroups(
      client, sessionId, userId, role, registerOptions.groupKeys, !viaInvite && !registerOptions.approvedRequest,
    );
    const queued = await joinWaitlist(client, sessionId, userId, { joinedVia, groupKeys });
    if (queued.isNew) {
      await recordEventAudit({
        sessionId, actorId: userId, action: 'waitlist.joined', automatic: false, subjectUserIds: [userId],
        after: { joinedVia, position: queued.position },
      }, client);
    }
    return { kind: 'waitlisted', position: queued.position, isNew: queued.isNew };
  }
}

/** Take oneself off the line. Leaving a line one is not on changes nothing ({ left: false }). */
export async function leaveWaitlist(sessionId: string, userId: string): Promise<{ left: boolean }> {
  const r = await query(
    `UPDATE event_waitlist SET status = 'left', decided_at = NOW(), decided_by = $2, updated_at = NOW()
      WHERE session_id = $1 AND user_id = $2 AND status = 'waiting'`,
    [sessionId, userId],
  );
  const left = (r.rowCount ?? 0) > 0;
  if (left) {
    void recordEventAudit({ sessionId, actorId: userId, action: 'waitlist.left', automatic: false, subjectUserIds: [userId] });
    void emitWaitlistChanged(sessionId, [userId]);
  }
  return { left };
}

// ─── The organisers ──────────────────────────────────────────────────────────

/** The waiting list is the organisers' to see and manage: the people who answer the event's requests (managesRequests). */
async function requireOrganiser(sessionId: string, actor: Actor): Promise<void> {
  const facts = await readEventAccessFacts(sessionId, actor.userId);
  if (!facts) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  if (!managesRequests(facts, actor.role)) throw new ForbiddenError(NOT_ORGANISER);
}

interface LineRow {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  position: number | string;
  queued_at: Date | string;
  joined_via: WaitlistJoinedVia;
  account_kind: string | null;
}

/** The line in order, as the organisers see it (500 at most). Never an email. */
export async function listWaitlist(sessionId: string, actor: Actor): Promise<WaitlistEntryCard[]> {
  await requireOrganiser(sessionId, actor);
  const r = await query<LineRow>(
    `SELECT w.user_id, u.display_name, u.avatar_url, w.queued_at, w.joined_via, u.account_kind,
            ROW_NUMBER() OVER (ORDER BY w.queued_at, w.id) AS position
       FROM event_waitlist w
       JOIN users u ON u.id = w.user_id
      WHERE w.session_id = $1 AND w.status = 'waiting' AND ${activeMemberSql('u')}
      ORDER BY w.queued_at, w.id
      LIMIT $2`,
    [sessionId, WAITLIST_LIST_MAX],
  );
  return r.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name?.trim() || 'Guest',
    avatarUrl: row.avatar_url,
    position: Number(row.position),
    queuedAt: new Date(row.queued_at).toISOString(),
    joinedVia: row.joined_via,
    accountKind: row.account_kind === 'event_guest' ? 'event_guest' : 'member',
  }));
}

/** An organiser takes someone off the line. They are not told by a bell; their event page shows the change. */
export async function removeFromWaitlist(sessionId: string, actor: Actor, userId: string): Promise<void> {
  await requireOrganiser(sessionId, actor);
  const r = await query(
    `UPDATE event_waitlist SET status = 'removed', decided_at = NOW(), decided_by = $3, updated_at = NOW()
      WHERE session_id = $1 AND user_id = $2 AND status = 'waiting'`,
    [sessionId, userId, actor.userId],
  );
  if ((r.rowCount ?? 0) === 0) throw new AppError(404, ErrorCodes.WAITLIST_ENTRY_NOT_FOUND, NOT_WAITING);
  void recordEventAudit({ sessionId, actorId: actor.userId, action: 'waitlist.removed', automatic: false, subjectUserIds: [userId] });
  void emitWaitlistChanged(sessionId, [userId]);
}

/**
 * An organiser's "Let in now": the person is given a place over capacity, through every other rule (a refusal comes
 * back to the organiser and changes nothing), and is told as a promotion is. Audited waitlist.admitted_over_capacity.
 */
export async function admitFromWaitlist(sessionId: string, actor: Actor, userId: string): Promise<void> {
  await requireOrganiser(sessionId, actor);
  await transaction(async (client) => {
    await lockEventCapacity(client, sessionId);
    const entry = await waitingEntry(client, sessionId, userId);
    if (!entry) throw new AppError(404, ErrorCodes.WAITLIST_ENTRY_NOT_FOUND, NOT_WAITING);
    // An invite or an approval that no longer stands gives no say-so here either; the organiser's own act lets them in
    // over capacity, and every other rule still decides (a refusal comes back to the organiser).
    const said = await sayingSo(client, sessionId, entry);
    await registerParticipantTx(client, sessionId, userId, entry.role ?? undefined, {
      ...('options' in said ? said.options : baseOptions(entry)), overCapacity: true,
    });
    await recordEventAudit({
      sessionId, actorId: actor.userId, action: 'waitlist.admitted_over_capacity', automatic: false, subjectUserIds: [userId],
    }, client);
  });
  void emitEventAuditChanged(sessionId);
  await announcePromotions(sessionId, [userId]);
}

// ─── Promotion ───────────────────────────────────────────────────────────────

interface WaitingEntry {
  id: string;
  user_id: string;
  joined_via: WaitlistJoinedVia;
  group_keys: string[] | null;
  role: UserRole | null;
}

/** The person's waiting row, locked for this transaction (so leaving the line waits for a promotion in flight). */
async function waitingEntry(client: PoolClient, sessionId: string, userId: string): Promise<WaitingEntry | null> {
  const r = await client.query<WaitingEntry>(
    `SELECT w.id, w.user_id, w.joined_via, w.group_keys, u.role
       FROM event_waitlist w JOIN users u ON u.id = w.user_id
      WHERE w.session_id = $1 AND w.user_id = $2 AND w.status = 'waiting'
      FOR UPDATE OF w`,
    [sessionId, userId],
  );
  return r.rows[0] ?? null;
}

/** What every promotion carries: it comes from the line, with the group the person chose when they joined it. */
function baseOptions(entry: WaitingEntry): RegisterTxOptions {
  const groupKeys = entry.group_keys && entry.group_keys.length > 0 ? entry.group_keys : undefined;
  return { fromWaitlist: true, ...(groupKeys ? { groupKeys } : {}) };
}

/**
 * The say-so a waiting person is promoted with: the one they joined the line with, while it still stands. Controller
 * ruling (fix round 1, review M-2): someone who joined through an invite comes in through that invite only while it is
 * valid (accepted, or pending and not expired); a revoked or expired one lapses them with its own refusal code
 * (INVITE_REVOKED, INVITE_EXPIRED; INVITE_NOT_FOUND when none is left). Someone who joined through an approval keeps it
 * unless their request is no longer approved (EVENT_NEEDS_APPROVAL). Everyone else is checked by the rules alone.
 */
async function sayingSo(
  client: PoolClient, sessionId: string, entry: WaitingEntry,
): Promise<{ options: RegisterTxOptions } | { refusal: string }> {
  const base = baseOptions(entry);
  if (entry.joined_via === 'invite') {
    const invites = await client.query<{ status: string; past: boolean }>(
      `SELECT i.status::text AS status, (i.expires_at IS NOT NULL AND i.expires_at <= NOW()) AS past
         FROM invites i
        WHERE i.session_id = $1
          AND (i.accepted_by_user_id = $2 OR lower(i.invitee_email) = (SELECT lower(iu.email) FROM users iu WHERE iu.id = $2))`,
      [sessionId, entry.user_id],
    );
    const rows = invites.rows;
    if (rows.some((i) => i.status === 'accepted' || (i.status === 'pending' && !i.past))) return { options: { ...base, viaInvite: true } };
    if (rows.some((i) => i.status === 'revoked')) return { refusal: ErrorCodes.INVITE_REVOKED };
    if (rows.some((i) => i.status === 'expired' || i.past)) return { refusal: ErrorCodes.INVITE_EXPIRED };
    return { refusal: ErrorCodes.INVITE_NOT_FOUND };
  }
  if (entry.joined_via === 'approval') {
    const request = await client.query<{ status: string }>(
      `SELECT status FROM event_join_requests WHERE session_id = $1 AND user_id = $2`,
      [sessionId, entry.user_id],
    );
    if (request.rows[0]?.status === 'approved') return { options: { ...base, approvedRequest: true } };
    return { refusal: ErrorCodes.EVENT_NEEDS_APPROVAL };
  }
  return { options: base };
}

/** A turn that lapses (with why), audited as the product's own act. */
async function lapse(client: PoolClient, sessionId: string, entry: WaitingEntry, reason: string, pass: PromotionPass): Promise<void> {
  await client.query(
    `UPDATE event_waitlist SET status = 'lapsed', lapsed_reason = $2, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'waiting'`,
    [entry.id, reason],
  );
  pass.lapsed.push({ userId: entry.user_id, reason });
  await recordEventAudit({
    sessionId, actorId: null, action: 'waitlist.lapsed', automatic: true, subjectUserIds: [entry.user_id], reason,
  }, client);
}

interface PromotionPass {
  promoted: string[];
  lapsed: Array<{ userId: string; reason: string }>;
}

async function promoteTx(client: PoolClient, sessionId: string): Promise<PromotionPass> {
  const pass: PromotionPass = { promoted: [], lapsed: [] };
  await lockEventCapacity(client, sessionId);
  const ev = await client.query<{ status: string; publication: string | null; capacity: number | string | null; taken: number | string }>(
    `SELECT s.status::text AS status, s.publication, ${eventCapacitySql('s')} AS capacity, ${capacityTakenSql('s')} AS taken
       FROM sessions s WHERE s.id = $1`,
    [sessionId],
  );
  const event = ev.rows[0];
  if (!event || event.status === 'completed' || event.status === 'cancelled' || event.publication === 'draft') return pass;
  // An event with no limit any more (its capacity cleared) takes everyone waiting, one pass at a time.
  let free = event.capacity === null ? WAITLIST_LIST_MAX : Number(event.capacity) - (Number(event.taken) || 0);
  let tries = 0;
  while (free > 0 && tries < WAITLIST_LIST_MAX) {
    tries += 1;
    const next = await client.query<WaitingEntry>(
      `SELECT w.id, w.user_id, w.joined_via, w.group_keys, u.role
         FROM event_waitlist w JOIN users u ON u.id = w.user_id
        WHERE w.session_id = $1 AND w.status = 'waiting'
        ORDER BY w.queued_at, w.id
        LIMIT 1
        FOR UPDATE OF w`,
      [sessionId],
    );
    const entry = next.rows[0];
    if (!entry) break;
    const said = await sayingSo(client, sessionId, entry);
    if ('refusal' in said) {
      await lapse(client, sessionId, entry, said.refusal, pass);
      continue;
    }
    await client.query('SAVEPOINT promote_one');
    try {
      const place = await registerParticipantTx(client, sessionId, entry.user_id, entry.role ?? undefined, said.options);
      await client.query('RELEASE SAVEPOINT promote_one');
      if (place.isNewRegistration) {
        free -= 1;
        pass.promoted.push(entry.user_id);
        await recordEventAudit({
          sessionId, actorId: null, action: 'waitlist.promoted', automatic: true, subjectUserIds: [entry.user_id],
        }, client);
      }
    } catch (err) {
      // Fix round 1 (review M-3): rolled back to, then released, so a pass with many lapses nests no subtransactions.
      await client.query('ROLLBACK TO SAVEPOINT promote_one');
      await client.query('RELEASE SAVEPOINT promote_one');
      if (!(err instanceof AppError)) throw err;
      // Someone the count says fits but the registration finds full (an admin's own place over the line): stop here.
      if (err.code === ErrorCodes.SESSION_FULL) break;
      if (err.code === ErrorCodes.SESSION_ALREADY_REGISTERED) {
        await client.query(
          `UPDATE event_waitlist SET status = 'promoted', decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'waiting'`,
          [entry.id],
        );
        continue;
      }
      // No longer allowed in (an entitlement revoked, a removal, an account closed): their turn lapses, with why.
      await lapse(client, sessionId, entry, String(err.code ?? 'REFUSED').slice(0, 64), pass);
    }
  }
  return pass;
}

/**
 * Fill every free place from the front of the line, under the event's capacity lock: each person through every rule
 * (registerParticipantTx with the say-so they joined with, under a savepoint); a refusal lapses that entry with its code
 * and the next person is tried. A completed, cancelled or draft event promotes nobody. Returns who was given a place;
 * the notices are afterPlaceFreed's, once this has committed. With a `client`, it runs in the caller's transaction.
 */
export async function promoteFromWaitlist(sessionId: string, client?: PoolClient): Promise<string[]> {
  const pass = client ? await promoteTx(client, sessionId) : await transaction((c) => promoteTx(c, sessionId));
  return pass.promoted;
}

/**
 * Every path that frees a place calls this after its own write has committed: promote, then tell (the live state, bells,
 * emails, tags). Never throws: a failure is logged and the next freed place, or an organiser, carries the line on.
 */
export async function afterPlaceFreed(sessionId: string, cause: PlaceFreedCause): Promise<void> {
  try {
    const pass = await transaction((c) => promoteTx(c, sessionId));
    if (pass.promoted.length === 0 && pass.lapsed.length === 0) return;
    logger.info({ sessionId, cause, promoted: pass.promoted.length, lapsed: pass.lapsed.length }, 'Waiting list moved on');
    void emitEventAuditChanged(sessionId);
    if (pass.promoted.length > 0) await announcePromotions(sessionId, pass.promoted);
    else void emitWaitlistChanged(sessionId, pass.lapsed.map((l) => l.userId));
  } catch (err) {
    logger.warn({ err, sessionId, cause }, 'A place freed, but the waiting list could not move on (non-fatal)');
  }
}

/**
 * Part 3 Task 3, fix round 1 (review I-2): the upcoming and live events where these accounts, while still active, hold a
 * place, read in one statement before their status is written (the admin's bulk action and a report resolved with a
 * suspension or a ban write users.status themselves). Pass the answer to moveWaitlistsOn once the write has committed.
 */
export async function eventsHeldByActiveAccounts(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const r = await query<{ session_id: string }>(
    `SELECT DISTINCT sp.session_id FROM session_participants sp
       JOIN sessions s ON s.id = sp.session_id
       JOIN users u ON u.id = sp.user_id
      WHERE sp.user_id = ANY($1::uuid[]) AND u.status = 'active' AND sp.status <> 'removed'
        AND s.status NOT IN ('completed', 'cancelled')`,
    [userIds],
  );
  return (r?.rows ?? []).map((row) => row.session_id);
}

/** Part 3 Task 3, fix round 1: each of these events' waiting list moves on (in the background; never throws). */
export function moveWaitlistsOn(sessionIds: string[]): void {
  for (const sessionId of new Set(sessionIds)) void afterPlaceFreed(sessionId, 'account');
}

// ─── Telling people ──────────────────────────────────────────────────────────

/**
 * The waiting list changed: the organisers' list (session:<id>:waitlist) and everyone on the line, whose position may
 * have moved (session:<id>, their access block). `people` are the ones whose own state changed (joined, left, removed,
 * lapsed, promoted): they also get their own user:<id>:sessions (the call link's list of their events). Never throws.
 */
export async function emitWaitlistChanged(sessionId: string, people: string[] = []): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const [organisers, line] = await Promise.all([
      resolveEventOrganiserIds(sessionId),
      query<{ user_id: string }>(
        `SELECT user_id FROM event_waitlist WHERE session_id = $1 AND status = 'waiting' LIMIT $2`,
        [sessionId, WAITLIST_LIST_MAX],
      ),
    ]);
    const everyone = [...new Set([...organisers, ...line.rows.map((r) => r.user_id), ...people])];
    await emitEntities(io, everyone, [E.sessionWaitlist(sessionId), E.session(sessionId)]);
    for (const person of people) await emitEntities(io, [person], [E.userSessions(person)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'emitWaitlistChanged: failed to fan out');
  }
}

interface PromotedEventRow {
  title: string;
  status: string;
  scheduled_at: Date | string | null;
  timezone: string | null;
  call_code: string | null;
  pod_id: string | null;
}

interface PromotedPersonRow {
  id: string;
  email: string | null;
  account_kind: string | null;
}

/** The bell's words: before the start, or while it is live (Part 3 Task 3 copy). */
export function promotionBell(event: { title: string; live: boolean; scheduledAt: Date | string | null; timezone: string | null }, now: Date = new Date()): { title: string; body: string } {
  const title = `A place opened in ${event.title}: it's yours`;
  if (event.live) return { title, body: "It's on now. Join from the event page." };
  const unregister = "Can't make it? Unregister so the next person gets it.";
  if (!event.scheduledAt) return { title, body: unregister };
  return { title, body: `Starts ${relativeEventTime(event.scheduledAt, now, event.timezone)}. ${unregister}` };
}

/**
 * The promoted people's live state, bells, emails and tags. A member's bell and email open the event page; a guest's
 * open the event's RSN Call link (a guest has no member surface). Never throws.
 */
async function announcePromotions(sessionId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    for (const userId of userIds) await syncLiveRegistration(sessionId, userId);
    const ev = await query<PromotedEventRow>(
      `SELECT title, status::text AS status, scheduled_at, timezone, call_code, pod_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const event = ev.rows[0];
    if (!event) return;
    const people = (await query<PromotedPersonRow>(
      `SELECT id, email, account_kind FROM users WHERE id = ANY($1::uuid[])`,
      [userIds],
    )).rows;
    const guests = people.filter((p) => p.account_kind === 'event_guest');
    const members = people.filter((p) => p.account_kind !== 'event_guest');
    const code = guests.length > 0 ? (event.call_code ?? await ensureCallCode(sessionId)) : event.call_code;
    const memberPath = `/sessions/${sessionId}`;
    const guestPath = code ? callLinkPath(code) : memberPath;
    const live = isLiveStatus(event.status);
    const bell = promotionBell({ title: event.title, live, scheduledAt: event.scheduled_at, timezone: event.timezone });
    await ringEventBells('event_waitlist_promoted', members.map((p) => ({ userId: p.id, title: bell.title })), bell.body, memberPath);
    await ringEventBells('event_waitlist_promoted', guests.map((p) => ({ userId: p.id, title: bell.title })), bell.body, guestPath);

    void fanoutSessionEntities(event.pod_id, sessionId, [
      E.sessionParticipants(sessionId), E.sessionWaitlist(sessionId), ...userIds.map((id) => E.userSessions(id)),
    ]);
    // A promoted person was no fanout recipient a moment ago (fanoutSessionEntities reads the places): told directly.
    const io = getRealtimeIo();
    if (io) {
      for (const userId of userIds) {
        await emitEntities(io, [userId], [E.session(sessionId), E.userSessions(userId), E.sessionParticipants(sessionId)]);
      }
    }
    void emitWaitlistChanged(sessionId);
    void emailPromotions(sessionId, event, live, [
      ...members.map((p) => ({ email: p.email, link: `${config.clientUrl}${memberPath}` })),
      ...guests.map((p) => ({ email: p.email, link: `${config.clientUrl}${guestPath}` })),
    ]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'People were promoted from the waiting list, but not every notice went (non-fatal)');
  }
}

/** One email each (the bulk lane when several), with the event's calendar file. Gated by the admin switch only. */
async function emailPromotions(
  sessionId: string, event: PromotedEventRow, live: boolean, recipients: Array<{ email: string | null; link: string }>,
): Promise<void> {
  try {
    if (!(await emailService.isEmailTypeEnabled('event_waitlist_promoted'))) return;
    const wanted = recipients.filter((r): r is { email: string; link: string } => !!r.email);
    if (wanted.length === 0) return;
    const calendarEvent = await buildSessionCalendarEvent(sessionId);
    const when = live ? "It's on now." : event.scheduled_at ? formatEventTime(event.scheduled_at, event.timezone, 'long') : '';
    const sendAll = async (): Promise<void> => {
      for (const person of wanted) {
        await emailService.sendWaitlistPromotedEmail(person.email, {
          eventTitle: event.title, when, link: person.link, live, calendarEvent,
        }).catch((err: unknown) => {
          logger.warn({ err, sessionId }, 'Waiting-list promotion email failed (non-fatal)');
        });
      }
    };
    if (wanted.length > 1) await emailService.asBulkEmail(sendAll);
    else await sendAll();
  } catch (err) {
    logger.warn({ err, sessionId }, 'Waiting-list promotion emails could not be sent (non-fatal)');
  }
}
