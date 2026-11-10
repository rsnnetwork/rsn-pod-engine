// ─── What the one room checker needs to know about an event (10 Nov 2026 spec, Part 2 Task 5) ─────────────
//
// shared/src/events/room-check.ts decides whether a room may stand from a RoomCheckContext. This loads one for an
// event and a round, from the database: the event's group rules (null for an event without groups, which then
// meets only the hard exclusions and the size), each person's groups, the pairs that must never meet, and the
// pairs that already met in an earlier round of this event.
//
// The hard exclusions are the ones generateSingleRound gives the engine (matching.service.ts, "Build hard
// constraints"): an inviter and the person who accepted their invite to this event, a block in either direction,
// and a report that was not dismissed. Read once per call; the checker then answers from memory.

import type { PoolClient, QueryResultRow } from 'pg';
import type { RoomCheckContext } from '@rsn/shared';
import { query } from '../../db';
import { pairKey } from './matching.interface';
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
 * The pairs of this event's people who must never meet, each as pairKey(a, b): an inviter and whoever accepted
 * their invite to this event, a block either way, a report that was not dismissed.
 */
export async function hardExclusionPairs(sessionId: string, userIds: string[], client?: PoolClient): Promise<Set<string>> {
  const read = readerOf(client);
  const pairs = new Set<string>();
  const invites = await read<{ inviter_id: string | null; accepted_by_user_id: string }>(
    `SELECT inviter_id, accepted_by_user_id FROM invites
      WHERE session_id = $1 AND accepted_by_user_id IS NOT NULL AND status = 'accepted'`,
    [sessionId],
  );
  for (const r of invites.rows) if (r.inviter_id) pairs.add(pairKey(r.inviter_id, r.accepted_by_user_id));
  if (userIds.length < 2) return pairs;
  const blocks = await read<{ a: string; b: string }>(
    `SELECT blocker_id AS a, blocked_id AS b FROM user_blocks WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($1::uuid[])`,
    [userIds],
  );
  const reports = await read<{ a: string; b: string }>(
    `SELECT reporter_id AS a, reported_user_id AS b FROM violations
      WHERE status <> 'dismissed' AND reporter_id IS NOT NULL
        AND reporter_id = ANY($1::uuid[]) AND reported_user_id = ANY($1::uuid[])`,
    [userIds],
  );
  for (const r of [...blocks.rows, ...reports.rows]) pairs.add(pairKey(r.a, r.b));
  return pairs;
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
  const excluded = await hardExclusionPairs(sessionId, people, opts.client);
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
