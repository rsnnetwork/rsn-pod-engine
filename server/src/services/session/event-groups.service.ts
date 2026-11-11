// ─── An event's matching groups and round rules (10 Nov 2026 spec, Part 2 Task 5; sections 05, 02, 07) ─────
//
// The organiser names the event's groups, asks one required question, and says per round who may meet whom
// (shared/src/events/group-rules.ts holds the rule; room-check.ts the one checker). This file stores them and
// each person's groups. An event with no event_groups rows has no rules: getEventGroupRules answers null and
// every caller (registration, the engine, the board) behaves exactly as it did before groups existed.
//
// A group is the event's own fact about a person. It is never read from the account's platform standing or
// profile, and it grants nothing: who may change the rules is decided by canActAsHost alone (spec 05,
// "Critical distinction").
//
// Part 3 Task 12: the rules also say who may override them (event_matching_rules.override_by, migration 147): the
// owner alone ('owner', also when nothing was chosen) or the owner and the event's co-hosts. Only the owner
// (host_user_id) or a super admin may change that choice; everyone else who runs the event keeps their say over the
// rest, and no save changes it unless it says so: removing every group keeps it (the row stays, holding only the
// choice, when it is not the default). The override itself is decided by mayOverrideGroupRules
// (services/matching/live-room-guard.ts).

import type { PoolClient, QueryResultRow } from 'pg';
import {
  DEFAULT_GROUP_QUESTION, DEFAULT_SESSION_CONFIG, ErrorCodes, explainRoundCapacity, groupPairKey, validateGroupRules,
  type EventGroupRules, type EventGroupsView, type GroupFallback, type GroupOverrideBy, type RoundRule, type RoundRuleMode,
  type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { canActAsHost } from '../roles/effective-role.service';
import { resolveEventOrganiserIds } from '../post-event-message/event-organisers';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { isLiveStatus } from './main-room';
import { canSeeEvent, readEventAccessFacts } from './event-access';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { isEventOwnerOrSuperAdmin } from './event-owner';

/** Who is acting: the signed-in person and their platform role (the shape of Part 2's `Actor`). */
export interface GroupsActor {
  userId: string;
  role: UserRole;
}

export type GroupAssigner = 'self' | 'organiser' | 'invitation';

/** A read in the caller's transaction when there is one, else on the pool. */
type Reader = <R extends QueryResultRow>(text: string, params: unknown[]) => Promise<{ rows: R[] }>;
const readerOf = (client?: PoolClient): Reader =>
  client ? (text, params) => client.query(text, params) : (text, params) => query(text, params);

const NOT_FOUND = "We couldn't find that event.";
const LIVE_REFUSAL = "Group rules can't change while the event is live.";
const ORGANISERS_ONLY = 'Only the people running this event can change its groups.';
const UNKNOWN_GROUP = "That group isn't one of this event's groups.";
const OWNER_CHOOSES_OVERRIDE = "Only the event's owner can choose who may override group rules.";

// ─── Reading ─────────────────────────────────────────────────────────────────

interface GroupRow { key: string; label: string; description: string | null }
interface MatchingRow {
  group_question: string;
  allow_multiple: boolean;
  imbalance_fallback: GroupFallback;
  /** Migration 147; a row read before it ran (or a stand-in without it) reads as 'owner'. */
  override_by?: GroupOverrideBy | null;
}
interface RoundRow { from_round: number; to_round: number; mode: RoundRuleMode; allowed_pairs: string[] | null }

/**
 * The event's groups and rules, or null when it has none (the inert path: one read, nothing else). With a
 * client, read inside the caller's transaction.
 */
export async function getEventGroupRules(sessionId: string, client?: PoolClient): Promise<EventGroupRules | null> {
  const read = readerOf(client);
  const groups = await read<GroupRow>(
    `SELECT key, label, description FROM event_groups WHERE session_id = $1 ORDER BY position, key`,
    [sessionId],
  );
  if (groups.rows.length === 0) return null;
  const matching = await read<MatchingRow>(
    `SELECT group_question, allow_multiple, imbalance_fallback, override_by FROM event_matching_rules WHERE session_id = $1`,
    [sessionId],
  );
  const rounds = await read<RoundRow>(
    `SELECT from_round, to_round, mode, allowed_pairs FROM event_round_rules WHERE session_id = $1 ORDER BY from_round`,
    [sessionId],
  );
  const m = matching.rows[0];
  return {
    groups: groups.rows.map((g) => ({ key: g.key, label: g.label, description: g.description })),
    question: m?.group_question ?? DEFAULT_GROUP_QUESTION,
    allowMultiple: m?.allow_multiple ?? false,
    fallback: m?.imbalance_fallback ?? 'leave_unmatched',
    rounds: rounds.rows.map((r) => ({
      fromRound: r.from_round, toRound: r.to_round, mode: r.mode, allowedPairs: r.allowed_pairs ?? [],
    })),
    overrideBy: m?.override_by === 'owner_and_cohosts' ? 'owner_and_cohosts' : 'owner',
  };
}

/**
 * The owner's stored choice of who may override (Part 3 Task 12), read on its own: it is kept even when the event has
 * no groups (getEventGroupRules then answers null). No row is 'owner'.
 */
async function storedOverrideBy(read: Reader, sessionId: string): Promise<GroupOverrideBy> {
  const result = await read<{ override_by: string | null }>(
    `SELECT override_by FROM event_matching_rules WHERE session_id = $1`, [sessionId],
  );
  return result.rows[0]?.override_by === 'owner_and_cohosts' ? 'owner_and_cohosts' : 'owner';
}

/** One person's group keys in this event, in the event's group order. */
async function keysOf(read: Reader, sessionId: string, userId: string): Promise<string[]> {
  const result = await read<{ key: string }>(
    `SELECT g.key FROM event_participant_groups pg JOIN event_groups g ON g.id = pg.group_id
      WHERE pg.session_id = $1 AND pg.user_id = $2 ORDER BY g.position, g.key`,
    [sessionId, userId],
  );
  return result.rows.map((r) => r.key);
}

/** Every person's group keys in this event (people with no group are not in the map), in the caller's transaction if given. */
export async function groupsForParticipants(sessionId: string, client?: PoolClient): Promise<Map<string, string[]>> {
  const result = await readerOf(client)<{ user_id: string; keys: string[] }>(
    `SELECT pg.user_id, array_agg(g.key ORDER BY g.position, g.key) AS keys
       FROM event_participant_groups pg JOIN event_groups g ON g.id = pg.group_id
      WHERE pg.session_id = $1
      GROUP BY pg.user_id`,
    [sessionId],
  );
  return new Map(result.rows.map((r) => [r.user_id, r.keys]));
}

// ─── Telling people ──────────────────────────────────────────────────────────

/** The people running the event and everyone who holds a place: anyone whose groups screen may be open. */
export async function fanoutEventGroups(sessionId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const [organisers, participants] = await Promise.all([
      resolveEventOrganiserIds(sessionId),
      query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status <> 'removed'`,
        [sessionId],
      ),
    ]);
    const people = [...new Set([...organisers, ...participants.rows.map((r) => r.user_id)])];
    await emitEntities(io, people, [E.sessionGroups(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutEventGroups: failed to fan out');
  }
}

// ─── The audit row ───────────────────────────────────────────────────────────

/**
 * One event-audit row for a change to the event's groups, through the event audit trail (Part 2 Task 1), in the
 * caller's transaction: it throws, so the change and its row stand or fall together. The organisers' history is told
 * (emitEventAuditChanged) once the transaction has committed, by the caller.
 */
async function auditGroups(
  client: PoolClient,
  entry: { sessionId: string; actorId: string | null; action: 'group.rules_changed' | 'group.assigned'; subjectUserIds: string[]; before: unknown; after: unknown },
): Promise<void> {
  await recordEventAudit({ ...entry, automatic: false }, client);
}

// ─── The organiser saves the rules ───────────────────────────────────────────

async function requireOrganiser(sessionId: string, actor: GroupsActor): Promise<void> {
  const { allowed } = await canActAsHost(actor.userId, actor.role, sessionId);
  if (allowed) return;
  // Part 2 Task 2: an event this person cannot see (a draft, to anyone who does not run it) answers exactly as an id
  // that does not exist, never "only organisers", so its groups routes never tell that it is there.
  const facts = await readEventAccessFacts(sessionId, actor.userId);
  if (!facts || !canSeeEvent(facts, actor.role)) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  throw new ForbiddenError(ORGANISERS_ONLY);
}

/** Labels and the question trimmed, pairs in their one form without repeats, ranges in round order. */
function normalised(rules: EventGroupRules): EventGroupRules {
  return {
    ...(rules.overrideBy ? { overrideBy: rules.overrideBy } : {}),
    groups: rules.groups.map((g) => ({ key: g.key, label: g.label.trim(), description: g.description?.trim() || null })),
    question: rules.question.trim(),
    allowMultiple: rules.allowMultiple,
    fallback: rules.fallback,
    rounds: [...rules.rounds]
      .sort((a, b) => a.fromRound - b.fromRound)
      .map((r): RoundRule => ({
        fromRound: r.fromRound,
        toRound: r.toRound,
        mode: r.mode,
        allowedPairs: r.mode === 'custom'
          ? [...new Set(r.allowedPairs.map((p) => {
            // A malformed pair is kept as sent, so validateGroupRules refuses it instead of it being repaired.
            const parts = p.split('|');
            return parts.length === 2 ? groupPairKey(parts[0], parts[1]) : p;
          }))].sort()
          : [],
      })),
  };
}

function numberOfRoundsOf(config: unknown): number {
  const parsed = (typeof config === 'string' ? JSON.parse(config) : config ?? {}) as { numberOfRounds?: number };
  return Number(parsed.numberOfRounds) || DEFAULT_SESSION_CONFIG.numberOfRounds;
}

/**
 * Remove every group (the event goes back to having none); their memberships go with them. The owner's choice of who
 * may override is kept: a choice other than the default stays as a row holding only it (the question and the rest
 * back to their defaults), so the next groups saved start from it.
 */
async function clearGroups(client: PoolClient, sessionId: string, actorId: string, overrideBy: GroupOverrideBy): Promise<string[]> {
  const members = await client.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM event_participant_groups WHERE session_id = $1`, [sessionId],
  );
  await client.query(`DELETE FROM event_round_rules WHERE session_id = $1`, [sessionId]);
  await client.query(`DELETE FROM event_matching_rules WHERE session_id = $1`, [sessionId]);
  if (overrideBy !== 'owner') {
    await client.query(
      `INSERT INTO event_matching_rules (session_id, override_by, updated_by, updated_at) VALUES ($1, $2, $3, NOW())`,
      [sessionId, overrideBy, actorId],
    );
  }
  await client.query(`DELETE FROM event_groups WHERE session_id = $1`, [sessionId]);
  return members.rows.map((r) => r.user_id);
}

async function writeRules(
  client: PoolClient, sessionId: string, actorId: string, rules: EventGroupRules, overrideBy: GroupOverrideBy,
): Promise<string[]> {
  const keys = rules.groups.map((g) => g.key);
  // The people whose memberships a removed group takes with it (ON DELETE CASCADE).
  const dropped = await client.query<{ user_id: string }>(
    `SELECT DISTINCT pg.user_id FROM event_participant_groups pg JOIN event_groups g ON g.id = pg.group_id
      WHERE g.session_id = $1 AND NOT (g.key = ANY($2::text[]))`,
    [sessionId, keys],
  );
  await client.query(`DELETE FROM event_groups WHERE session_id = $1 AND NOT (key = ANY($2::text[]))`, [sessionId, keys]);
  await client.query(
    `INSERT INTO event_groups (session_id, key, label, description, position)
     SELECT $1::uuid, t.key, t.label, t.description, t.position
       FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS t(key, label, description, position)
     ON CONFLICT (session_id, key) DO UPDATE
       SET label = EXCLUDED.label, description = EXCLUDED.description, position = EXCLUDED.position`,
    [sessionId, keys, rules.groups.map((g) => g.label), rules.groups.map((g) => g.description ?? null), keys.map((_, i) => i)],
  );
  await client.query(
    `INSERT INTO event_matching_rules (session_id, group_question, allow_multiple, imbalance_fallback, updated_by, override_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (session_id) DO UPDATE
       SET group_question = EXCLUDED.group_question, allow_multiple = EXCLUDED.allow_multiple,
           imbalance_fallback = EXCLUDED.imbalance_fallback, updated_by = EXCLUDED.updated_by,
           override_by = EXCLUDED.override_by, updated_at = NOW()`,
    [sessionId, rules.question, rules.allowMultiple, rules.fallback, actorId, overrideBy],
  );
  await client.query(`DELETE FROM event_round_rules WHERE session_id = $1`, [sessionId]);
  if (rules.rounds.length > 0) {
    // A pair is two keys and a '|', and a key holds no comma, so each rule's pairs travel as one comma-joined text.
    await client.query(
      `INSERT INTO event_round_rules (session_id, from_round, to_round, mode, allowed_pairs)
       SELECT $1::uuid, t.from_round, t.to_round, t.mode,
              CASE WHEN t.pairs = '' THEN '{}'::text[] ELSE string_to_array(t.pairs, ',') END
         FROM unnest($2::int[], $3::int[], $4::text[], $5::text[]) AS t(from_round, to_round, mode, pairs)`,
      [
        sessionId,
        rules.rounds.map((r) => r.fromRound),
        rules.rounds.map((r) => r.toRound),
        rules.rounds.map((r) => r.mode),
        rules.rounds.map((r) => r.allowedPairs.join(',')),
      ],
    );
  }
  return dropped.rows.map((r) => r.user_id);
}

const emptyRules = (overrideBy: GroupOverrideBy): EventGroupRules => ({
  groups: [], question: DEFAULT_GROUP_QUESTION, allowMultiple: false, fallback: 'leave_unmatched', rounds: [], overrideBy,
});

/**
 * Part 3 Task 12: changing who may override is the owner's (host_user_id) or a super admin's alone, read from the
 * database in the caller's transaction (never the token). Anyone else gets 403.
 */
async function requireOwnerToChooseOverride(client: PoolClient, sessionId: string, actorId: string): Promise<void> {
  if (await isEventOwnerOrSuperAdmin(client, sessionId, actorId)) return;
  throw new ForbiddenError(OWNER_CHOOSES_OVERRIDE);
}

/**
 * The organiser saves the event's groups and round rules (host, co-host, the pod's admin or a super admin).
 * Refused while the event is live. A group left out is removed with its memberships. No groups at all removes
 * them all: the event goes back to matching as it did before. Audited `group.rules_changed` with before and after.
 * Who may override (`overrideBy`, Part 3 Task 12): left out keeps the stored choice ('owner' when there is none); a
 * value other than the stored one is the owner's or a super admin's to send (403 for anyone else, nothing written).
 * No other save changes it, removing every group included.
 */
export async function saveEventGroupRules(sessionId: string, actor: GroupsActor, rules: EventGroupRules): Promise<EventGroupRules> {
  // An unknown event reads as unknown to everyone (as GET does), before who is asking is looked at.
  const exists = await query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, [sessionId]);
  if (!exists.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  await requireOrganiser(sessionId, actor);
  const next = normalised(rules);
  const saved = await transaction(async (client) => {
    const event = await client.query<{ status: string; config: unknown }>(
      `SELECT status, config FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId],
    );
    if (!event.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
    if (isLiveStatus(event.rows[0].status)) throw new ConflictError(ErrorCodes.SESSION_IN_PROGRESS, LIVE_REFUSAL);
    if (event.rows[0].status === 'completed' || event.rows[0].status === 'cancelled') {
      throw new ConflictError(ErrorCodes.EVENT_ENDED, "This event has ended, so its groups can't change.");
    }
    const before = await getEventGroupRules(sessionId, client);
    const stored = await storedOverrideBy(readerOf(client), sessionId);
    const overrideBy: GroupOverrideBy = next.overrideBy ?? stored;
    if (overrideBy !== stored) await requireOwnerToChooseOverride(client, sessionId, actor.userId);
    if (next.groups.length > 0) {
      const issues = validateGroupRules(next, numberOfRoundsOf(event.rows[0].config));
      if (issues.length > 0) {
        const details: Record<string, string[]> = {};
        for (const issue of issues) (details[issue.field] ??= []).push(issue.message);
        throw new ValidationError(issues[0].message, details);
      }
    }
    const affected = next.groups.length === 0
      ? await clearGroups(client, sessionId, actor.userId, overrideBy)
      : await writeRules(client, sessionId, actor.userId, next, overrideBy);
    const after = next.groups.length === 0 ? null : await getEventGroupRules(sessionId, client);
    await auditGroups(client, {
      sessionId, actorId: actor.userId, action: 'group.rules_changed', subjectUserIds: affected, before, after,
    });
    return after ?? emptyRules(overrideBy);
  });
  void fanoutEventGroups(sessionId);
  void emitEventAuditChanged(sessionId);
  return saved;
}

// ─── A person's groups ───────────────────────────────────────────────────────

/** The keys as the event knows them: each once, every one the event's, and one only unless it allows more. */
function checkedKeys(rules: EventGroupRules, groupKeys: string[]): string[] {
  const keys = [...new Set(groupKeys)];
  const known = new Set(rules.groups.map((g) => g.key));
  if (keys.some((k) => !known.has(k))) throw new AppError(400, ErrorCodes.EVENT_GROUP_UNKNOWN, UNKNOWN_GROUP);
  if (keys.length > 1 && !rules.allowMultiple) {
    throw new AppError(400, ErrorCodes.EVENT_GROUP_UNKNOWN, 'Choose one group for this event.');
  }
  return keys;
}

async function replaceGroups(
  client: PoolClient, sessionId: string, userId: string, keys: string[], assignedBy: GroupAssigner, byUserId: string | null,
): Promise<void> {
  await client.query(
    `DELETE FROM event_participant_groups pg USING event_groups g
      WHERE g.id = pg.group_id AND pg.session_id = $1 AND pg.user_id = $2 AND NOT (g.key = ANY($3::text[]))`,
    [sessionId, userId, keys],
  );
  if (keys.length === 0) return;
  await client.query(
    `INSERT INTO event_participant_groups (session_id, user_id, group_id, assigned_by, assigned_by_user_id)
     SELECT $1::uuid, $2::uuid, g.id, $4::text, $5::uuid FROM event_groups g WHERE g.session_id = $1::uuid AND g.key = ANY($3::text[])
     ON CONFLICT (session_id, user_id, group_id) DO NOTHING`,
    [sessionId, userId, keys, assignedBy, byUserId],
  );
}

async function assignGroups(
  client: PoolClient, sessionId: string, actor: GroupsActor | null, userId: string, groupKeys: string[], assignedBy: GroupAssigner,
): Promise<boolean> {
  const rules = await getEventGroupRules(sessionId, client);
  if (!rules) throw new AppError(400, ErrorCodes.EVENT_GROUP_UNKNOWN, UNKNOWN_GROUP);
  const keys = checkedKeys(rules, groupKeys);
  if (assignedBy !== 'organiser' && keys.length === 0) {
    throw new ConflictError(ErrorCodes.EVENT_GROUP_REQUIRED, 'Choose your group for this event first.');
  }
  // One person's groups are written one call at a time, so two first choices never both land.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`event-groups:${sessionId}:${userId}`]);
  const current = await keysOf(readerOf(client), sessionId, userId);
  const same = current.length === keys.length && keys.every((k) => current.includes(k));
  if (same) return false;

  if (assignedBy === 'organiser') {
    await replaceGroups(client, sessionId, userId, keys, 'organiser', actor?.userId ?? null);
    await auditGroups(client, {
      sessionId, actorId: actor?.userId ?? null, action: 'group.assigned', subjectUserIds: [userId],
      before: { groupKeys: current }, after: { groupKeys: keys },
    });
    return true;
  }
  // A person's own choice, or the group their invitation carries, is made once; after that only an organiser moves them.
  if (current.length > 0) {
    if (assignedBy === 'invitation') return false;
    throw new ConflictError(ErrorCodes.EVENT_GROUP_ALREADY_CHOSEN, 'Your group for this event is already set. Ask the organiser to change it.');
  }
  await replaceGroups(client, sessionId, userId, keys, assignedBy, actor?.userId ?? null);
  return true;
}

/**
 * Put a person in the event's groups. `self` (their own choice when registering) and `invitation` (the group an
 * invitation or a code carries) only when they have none yet, exactly one key unless the event allows more.
 * `organiser`: any time, replaces their groups (an empty list takes them out of every group), audited
 * `group.assigned`. With a client, part of the caller's transaction (the caller tells the screens); without, its
 * own, and the screens are told here.
 */
export async function setParticipantGroups(
  sessionId: string,
  actor: GroupsActor | null,
  userId: string,
  groupKeys: string[],
  assignedBy: GroupAssigner,
  client?: PoolClient,
): Promise<void> {
  if (assignedBy === 'organiser') {
    if (!actor) throw new ForbiddenError(ORGANISERS_ONLY);
    await requireOrganiser(sessionId, actor);
  }
  if (client) {
    await assignGroups(client, sessionId, actor, userId, groupKeys, assignedBy);
    return;
  }
  const changed = await transaction(async (tx) => {
    if (assignedBy === 'organiser') {
      const held = await tx.query<{ status: string }>(
        `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`, [sessionId, userId],
      );
      if (!held.rows[0] || held.rows[0].status === 'removed') {
        throw new NotFoundError('Participant', userId, "That person isn't in this event.");
      }
    }
    return assignGroups(tx, sessionId, actor, userId, groupKeys, assignedBy);
  });
  if (!changed) return;
  void fanoutEventGroups(sessionId);
  // Only an organiser's regrouping is audited (group.assigned); a person's own first choice is not.
  if (assignedBy === 'organiser') void emitEventAuditChanged(sessionId);
}

/**
 * Registration's group question, inside registerParticipant's transaction, for an event that has groups.
 * Someone who already has a group keeps it (an organiser's choice, or their own earlier one; keys sent again are
 * checked, then left). Keys given to someone with none: written as their own choice (an unknown key is a 400).
 * None given: only a person's own first registration (`ownFirstPlace`) is asked to choose first (409
 * EVENT_GROUP_REQUIRED), unless they run the event; an approved request, an accepted invite, a returning place and
 * anyone an organiser adds are let in without a group, for the organiser to place (the board's basket).
 */
export async function applyRegistrationGroups(
  client: PoolClient, sessionId: string, userId: string, userRole: UserRole | undefined, groupKeys: string[] | undefined,
  ownFirstPlace: boolean,
): Promise<void> {
  const rules = await getEventGroupRules(sessionId, client);
  if (!rules) return;
  const keys = groupKeys && groupKeys.length > 0 ? checkedKeys(rules, groupKeys) : [];
  if ((await keysOf(readerOf(client), sessionId, userId)).length > 0) return;
  if (keys.length > 0) {
    await assignGroups(client, sessionId, null, userId, keys, 'self');
    return;
  }
  if (!ownFirstPlace) return;
  const { allowed } = await canActAsHost(userId, userRole, sessionId);
  if (allowed) return;
  throw new ConflictError(ErrorCodes.EVENT_GROUP_REQUIRED, 'Choose your group for this event first.');
}

/**
 * Part 3 Task 3: applyRegistrationGroups' question for someone joining a full event's waiting list, answered without
 * writing (a group written now would count on the board for someone who holds no place). The same refusals (an unknown
 * key is a 400; a person's own first place with no group chosen is 409 EVENT_GROUP_REQUIRED); the keys come back to be
 * kept on the waiting row and written as their own choice when they are promoted. An event without groups, and someone
 * who already has a group, keep nothing.
 */
export async function checkRegistrationGroups(
  client: PoolClient, sessionId: string, userId: string, userRole: UserRole | undefined, groupKeys: string[] | undefined,
  ownFirstPlace: boolean,
): Promise<string[]> {
  const rules = await getEventGroupRules(sessionId, client);
  if (!rules) return [];
  const keys = groupKeys && groupKeys.length > 0 ? checkedKeys(rules, groupKeys) : [];
  if ((await keysOf(readerOf(client), sessionId, userId)).length > 0) return [];
  if (keys.length > 0 || !ownFirstPlace) return keys;
  const { allowed } = await canActAsHost(userId, userRole, sessionId);
  if (allowed) return [];
  throw new ConflictError(ErrorCodes.EVENT_GROUP_REQUIRED, 'Choose your group for this event first.');
}

// ─── What a screen reads ─────────────────────────────────────────────────────

/**
 * Who the organiser's capacity counts: everyone with a place who will be matched (the host and co-hosts run the
 * event and are left out, as the live host set leaves them out), per group (someone in two groups counts in
 * both), and how many of them have no group yet.
 */
async function groupCounts(sessionId: string): Promise<{ counts: Record<string, number>; ungrouped: number }> {
  const matched = `SELECT sp.user_id FROM session_participants sp JOIN sessions s ON s.id = sp.session_id
      WHERE sp.session_id = $1 AND sp.status NOT IN ('removed', 'left', 'no_show')
        AND sp.user_id IS DISTINCT FROM s.host_user_id
        AND NOT EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = sp.session_id AND c.user_id = sp.user_id)`;
  const [byGroup, none] = await Promise.all([
    query<{ key: string; count: string }>(
      `SELECT g.key, COUNT(DISTINCT pg.user_id) AS count
         FROM event_groups g
         LEFT JOIN event_participant_groups pg ON pg.group_id = g.id AND pg.user_id IN (${matched})
        WHERE g.session_id = $1
        GROUP BY g.key`,
      [sessionId],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (${matched}) m
        WHERE NOT EXISTS (SELECT 1 FROM event_participant_groups pg WHERE pg.session_id = $1 AND pg.user_id = m.user_id)`,
      [sessionId],
    ),
  ]);
  return {
    counts: Object.fromEntries(byGroup.rows.map((r) => [r.key, Number(r.count)])),
    ungrouped: Number(none.rows[0]?.count ?? 0),
  };
}

/**
 * The event's groups as a viewer reads them: anyone who can see the event gets the groups, the question and
 * their own groups; the people running it also get the rules, the counts (with how many have no group yet),
 * each round's capacity and each person's groups (for the participant list's group chips). Someone who cannot see the event is told it does not exist, as for an unknown id.
 */
export async function readEventGroups(sessionId: string, viewer: GroupsActor): Promise<EventGroupsView> {
  const facts = await readEventAccessFacts(sessionId, viewer.userId);
  if (!facts || !canSeeEvent(facts, viewer.role)) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const rules = await getEventGroupRules(sessionId);
  const mine = rules ? await keysOf(readerOf(), sessionId, viewer.userId) : [];
  const view: EventGroupsView = {
    groups: rules?.groups ?? [],
    question: rules?.question ?? DEFAULT_GROUP_QUESTION,
    allowMultiple: rules?.allowMultiple ?? false,
    mine,
  };
  const { allowed } = await canActAsHost(viewer.userId, viewer.role, sessionId);
  if (!allowed) return view;
  const overrideBy = rules?.overrideBy ?? await storedOverrideBy(readerOf(), sessionId);
  if (!rules) return { ...view, rules: null, overrideBy, counts: {}, ungrouped: 0, capacity: [], members: {} };
  const [{ counts, ungrouped }, event, members] = await Promise.all([
    groupCounts(sessionId),
    query<{ config: unknown }>(`SELECT config FROM sessions WHERE id = $1`, [sessionId]),
    groupsForParticipants(sessionId),
  ]);
  const rounds = numberOfRoundsOf(event.rows[0]?.config);
  const capacity = Array.from({ length: rounds }, (_, i) => explainRoundCapacity(rules, i + 1, counts, rounds, ungrouped));
  return { ...view, rules, overrideBy, counts, ungrouped, capacity, members: Object.fromEntries(members) };
}
