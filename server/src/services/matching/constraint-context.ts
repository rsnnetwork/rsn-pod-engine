// ─── What the one room checker needs to know about an event (10 Nov 2026 spec, Part 2 Task 5) ─────────────
//
// shared/src/events/room-check.ts decides whether a room may stand from a RoomCheckContext. This loads one for an
// event and a round, from the database: the event's group rules (null for an event without groups, which then
// meets only the hard exclusions and the size), each person's groups, the pairs that must never meet, and the
// pairs that already met in an earlier round of this event.
//
// The hard exclusions come from hard-exclusions.ts, the one loader generateSingleRound also reads: an inviter and
// the person who accepted their invite to this event, a block in either direction, and a report that was not
// dismissed (a failed reports read is logged and skipped, as the engine does). Read once per call; the checker
// then answers from memory.

import type { PoolClient, QueryResultRow } from 'pg';
import type { EventGroupRules, RoomCheckContext } from '@rsn/shared';
import { query } from '../../db';
import { pairKey } from './matching.interface';
import { loadHardExclusions } from './hard-exclusions';
import { getEventGroupRules, groupsForParticipants } from '../session/event-groups.service';

type Reader = <R extends QueryResultRow>(text: string, params: unknown[]) => Promise<{ rows: R[] }>;
const readerOf = (client?: PoolClient): Reader =>
  client ? (text, params) => client.query(text, params) : (text, params) => query(text, params);

/** Everyone the event has a place for, a removed person aside. */
async function eventPeople(read: Reader, sessionId: string): Promise<string[]> {
  const result = await read<{ user_id: string }>(
    `SELECT user_id FROM session_participants WHERE session_id = $1 AND status <> 'removed'`, [sessionId],
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * The pairs of this event's people who must never meet, each as pairKey(a, b): exactly the engine's hard
 * exclusions (loadHardExclusions), with the engine's failure behaviour.
 */
export async function hardExclusionPairs(sessionId: string, userIds: string[]): Promise<Set<string>> {
  const { inviterInvitee, blocked } = await loadHardExclusions(sessionId, userIds);
  return new Set([...inviterInvitee, ...blocked].map((token) => {
    const [a, b] = token.split(':');
    return pairKey(a, b);
  }));
}

/** Pairs that met in an algorithm round before this one (a manual breakout is not a round), as pairKey(a, b). */
async function earlierRoundPairs(read: Reader, sessionId: string, round: number): Promise<Set<string>> {
  const result = await read<{ a: string; b: string; c: string | null }>(
    `SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches
      WHERE session_id = $1 AND round_number < $2 AND status IN ('completed', 'active') AND is_manual = FALSE`,
    [sessionId, round],
  );
  const pairs = new Set<string>();
  for (const m of result.rows) {
    pairs.add(pairKey(m.a, m.b));
    if (m.c) {
      pairs.add(pairKey(m.a, m.c));
      pairs.add(pairKey(m.b, m.c));
    }
  }
  return pairs;
}

/**
 * The checker's context for one round of one event. `earlierPairs` adds pairs the caller already knows met (or
 * will meet) earlier, each as pairKey(a, b) from matching.interface: the board's own planned earlier rounds,
 * which are not yet in `matches`. With a client, everything is read in the caller's transaction.
 */
export async function loadRoomCheckContext(
  sessionId: string,
  round: number,
  opts: { client?: PoolClient; earlierPairs?: Set<string> } = {},
): Promise<RoomCheckContext> {
  const read = readerOf(opts.client);
  const rules = await getEventGroupRules(sessionId, opts.client);
  const people = await eventPeople(read, sessionId);
  const excluded = await hardExclusionPairs(sessionId, people);
  const met = await earlierRoundPairs(read, sessionId, round);
  for (const key of opts.earlierPairs ?? []) met.add(key);
  const groups = rules ? await groupsForParticipants(sessionId, opts.client) : new Map<string, string[]>();
  return {
    round,
    rules,
    groupsOf: (userId) => groups.get(userId) ?? [],
    hardExcluded: (a, b) => excluded.has(pairKey(a, b)),
    metBefore: (a, b) => met.has(pairKey(a, b)),
    maxRoomSize: 3,
  };
}

// ─── The matching board: one read for every round (Part 2 Task 8) ──────────────────────────────────────────

/** What the checker needs about an event for all its rounds, read once (the board checks every round at a time). */
export interface EventCheckBase {
  rules: EventGroupRules | null;
  groups: Map<string, string[]>;
  /** Hard exclusions among the event's people, as pairKey(a, b). */
  excluded: Set<string>;
  /** Pairs that met in each played algorithm round of the live event (a manual breakout is not a round). */
  playedPairs: Map<number, Set<string>>;
}

/** Every played algorithm round's pairs (the pair, and the three of a trio), by round. */
async function playedRoundPairs(read: Reader, sessionId: string): Promise<Map<number, Set<string>>> {
  const result = await read<{ round_number: number; a: string; b: string; c: string | null }>(
    `SELECT round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches
      WHERE session_id = $1 AND status IN ('completed', 'active') AND is_manual = FALSE`,
    [sessionId],
  );
  const byRound = new Map<number, Set<string>>();
  for (const m of result.rows) {
    const pairs = byRound.get(m.round_number) ?? new Set<string>();
    pairs.add(pairKey(m.a, m.b));
    if (m.c) {
      pairs.add(pairKey(m.a, m.c));
      pairs.add(pairKey(m.b, m.c));
    }
    byRound.set(m.round_number, pairs);
  }
  return byRound;
}

/** Hard exclusions read earlier for a set of people (pairKeys), so a caller can avoid a pool read mid-transaction. */
export interface KnownExclusions {
  people: ReadonlySet<string>;
  pairs: Set<string>;
}

/**
 * The board's base: the same reads loadRoomCheckContext makes, once for every round. With a client, everything but
 * the hard exclusions is read in the caller's transaction; the exclusions (read through the engine's loader, on the
 * pool) are taken from `known` when it covers every one of the event's people now, else read again.
 */
export async function loadEventCheckBase(
  sessionId: string, opts: { client?: PoolClient; known?: KnownExclusions } = {},
): Promise<EventCheckBase> {
  const read = readerOf(opts.client);
  const rules = await getEventGroupRules(sessionId, opts.client);
  const people = await eventPeople(read, sessionId);
  const known = opts.known;
  const excluded = known && people.every((id) => known.people.has(id))
    ? known.pairs
    : await hardExclusionPairs(sessionId, people);
  const playedPairs = await playedRoundPairs(read, sessionId);
  const groups = rules ? await groupsForParticipants(sessionId, opts.client) : new Map<string, string[]>();
  return { rules, groups, excluded, playedPairs };
}

/**
 * The checker's context for one round from the board's base: met before = played in an earlier live round, or in
 * `earlierPairs` (the board's own other rounds, as pairKey(a, b)).
 */
export function roomCheckContextFor(base: EventCheckBase, round: number, earlierPairs: ReadonlySet<string>): RoomCheckContext {
  const met = new Set(earlierPairs);
  for (const [r, pairs] of base.playedPairs) if (r < round) for (const key of pairs) met.add(key);
  return {
    round,
    rules: base.rules,
    groupsOf: (userId) => base.groups.get(userId) ?? [],
    hardExcluded: (a, b) => base.excluded.has(pairKey(a, b)),
    metBefore: (a, b) => met.has(pairKey(a, b)),
    maxRoomSize: 3,
  };
}
