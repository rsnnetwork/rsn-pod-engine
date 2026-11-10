// ─── The live event following the published schedule (10 Nov 2026 spec, Part 2 Task 9; sections 07, 12/10) ─────
//
// Key decision D4, one schedule pipeline: for an event with a published version, the live `matches` table is always
// the latest version written out for the rounds not yet started. It is written
//   - at Start (materialisePublished, instead of the engine's plan), every round of the latest version, and then
//     anyone the version seats who is not there, or anyone there it does not seat, is repaired in;
//   - after every publish while the event is live (materialiseAfterPublish), only the rooms that changed;
//   - after every automatic repair (repairAffectedRounds), which edits the draft and publishes an automatic version.
// A round with an active or completed match is never rewritten, and a room's `matches` row that the new version keeps
// keeps its id. Every room written is checked by the one room checker with today's blocks, reports, invites and
// groups, so a block or a regroup made after the version was published is never seated through it; and when a round
// starts, the rows written from a version are checked once more (refuseBrokenScheduledRooms).
//
// Locks survive every live repair: someone leaving a locked meeting keeps their seat on the board, the meeting is
// flagged and the host told, and nobody is moved into it; Re-match keeps the round's locked meetings, and a live swap
// or exclude refuses them.
//
// An event with no published version takes today's path untouched: every entry point asks hasPublishedSchedule first,
// one indexed read, and the callers keep their own code for the answer "no".

import {
  checkRoom,
  type MatchingOutput, type RoundAssignment, type ScheduleSnapshot, type ScheduleSnapshotRoom,
} from '@rsn/shared';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { loadEventCheckBase, roomCheckContextFor } from '../matching/constraint-context';
import { withMatchGenerationLock } from '../orchestration/state/session-state';
import {
  absentIn, autoSeatable, cloneDraft, commitDraft, isEditable, isEnded, lockKey, nameOf, pairsOutside, prepareWrite, readSnapshot,
  readerOf, redistribute, removeSeat, roomsOf, sameSnapshot, seatOf, seatingNeeds, setRooms, snapshotOf, withLockedDraft,
  type BoardState, type Draft, type Rooms, type Seat,
} from './schedule-board.service';
import { announcePublished, publishLocked, type PublishedVersion } from './schedule-publish.service';

export type RepairReason = 'late_joiner' | 'left' | 'host_request';
export type ChangedRoom = { round: number; room: number };

/** Statuses of a place that is not someone to match now. */
const NOT_MATCHABLE = new Set(['removed', 'left', 'no_show']);
const LOCKED_MATCH = 'This meeting is locked on the matching board.';
export { LOCKED_MATCH as LOCKED_MATCH_MESSAGE };

// ─── Is the event on the board? ──────────────────────────────────────────────

/**
 * Whether the event has a published schedule version: the one question every live entry point asks before taking the
 * board's path. A failed read answers no (today's path), logged, so the board can never stop a live event.
 */
export async function hasPublishedSchedule(sessionId: string): Promise<boolean> {
  try {
    const result = await query<{ published_version: number | null }>(
      `SELECT published_version FROM event_schedules WHERE session_id = $1`, [sessionId],
    );
    return (result.rows[0]?.published_version ?? null) !== null;
  } catch (err) {
    logger.warn({ err, sessionId }, 'hasPublishedSchedule: read failed, taking the path without a schedule');
    return false;
  }
}

async function latestVersion(sessionId: string): Promise<number | null> {
  const result = await query<{ published_version: number | null }>(
    `SELECT published_version FROM event_schedules WHERE session_id = $1`, [sessionId],
  );
  return result.rows[0]?.published_version ?? null;
}

// ─── Writing a version into the live matches ────────────────────────────────

interface MatchRow {
  id: string;
  round_number: number;
  a: string;
  b: string | null;
  c: string | null;
  status: string;
  is_manual: boolean;
  locked: boolean;
  schedule_version: number | null;
  assignment_source: string | null;
  is_override: boolean;
}

const membersOf = (m: Pick<MatchRow, 'a' | 'b' | 'c'>) => [m.a, m.b, m.c].filter((id): id is string => !!id);
const compositionKey = (ids: string[]) => [...ids].sort().join(',');
/** Rows of a round that has started: anything but a planned or a cancelled one. */
const STARTED = (status: string) => status !== 'scheduled' && status !== 'cancelled';

interface Insert { round: number; room: ScheduleSnapshotRoom }
interface Keep { id: string; room: ScheduleSnapshotRoom }

/**
 * Write rounds >= `fromRound` of version `version` into `matches`. A round with any match that has started is left
 * alone, and so is a round the version does not have (a bonus round the host added live). In the others, every
 * planned row (status 'scheduled', not a host's breakout) whose room the version no longer has is deleted, every room
 * of the version that has no row is inserted, and a row whose room the version keeps stays, with its id (its lock and
 * version are brought up to date). With `onlyChangedRooms` false every planned row of those rounds is replaced. A room
 * of fewer than two people is not a meeting and is not written; a room the checker now refuses (a block, a report, an
 * invite, a group rule without an override) is not written either, and is returned in `refusedRooms`.
 */
export async function materialiseRounds(
  sessionId: string, version: number, fromRound: number, opts: { onlyChangedRooms: boolean },
): Promise<{ changedRooms: ChangedRoom[]; refusedRooms: ChangedRoom[] }> {
  const snapshot = await readSnapshot(readerOf(), sessionId, version);
  if (!snapshot) return { changedRooms: [], refusedRooms: [] };
  const rows = (await query<MatchRow>(
    `SELECT id, round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, status::text AS status,
            is_manual, locked, schedule_version, assignment_source, is_override
       FROM matches WHERE session_id = $1 AND round_number >= $2`,
    [sessionId, fromRound],
  )).rows;
  const rounds = snapshot.rounds.filter((r) => r.round >= fromRound);
  const base = await loadEventCheckBase(sessionId);

  const removals: string[] = [];
  const keeps: Keep[] = [];
  const inserts: Insert[] = [];
  const refusedRooms: ChangedRoom[] = [];
  for (const { round, rooms } of rounds) {
    const roundRows = rows.filter((m) => m.round_number === round && !m.is_manual);
    if (roundRows.some((m) => STARTED(m.status))) continue;
    const planned = roundRows.filter((m) => m.status === 'scheduled');
    const ctx = roomCheckContextFor(base, round, new Set());
    const wanted = rooms.filter((room) => {
      if (room.userIds.length < 2) return false;
      const ok = checkRoom(ctx, room.userIds, { override: room.override, fallback: true }).ok;
      if (!ok) refusedRooms.push({ round, room: room.room });
      return ok;
    });
    if (!opts.onlyChangedRooms) {
      removals.push(...planned.map((m) => m.id));
      inserts.push(...wanted.map((room) => ({ round, room })));
      continue;
    }
    const byComposition = new Map<string, MatchRow[]>();
    for (const m of planned) {
      const key = compositionKey(membersOf(m));
      byComposition.set(key, [...(byComposition.get(key) ?? []), m]);
    }
    for (const room of wanted) {
      const row = byComposition.get(compositionKey(room.userIds))?.shift();
      if (row) keeps.push({ id: row.id, room });
      else inserts.push({ round, room });
    }
    for (const left of byComposition.values()) removals.push(...left.map((m) => m.id));
  }

  if (removals.length > 0 || keeps.length > 0 || inserts.length > 0) {
    await transaction(async (client) => {
      if (removals.length > 0) {
        await client.query(`DELETE FROM matches WHERE id = ANY($1::uuid[]) AND status = 'scheduled'`, [removals]);
      }
      if (keeps.length > 0) {
        await client.query(
          `UPDATE matches m
              SET locked = t.locked, schedule_version = $2, assignment_source = t.source, is_override = t.override
             FROM unnest($1::uuid[], $3::boolean[], $4::text[], $5::boolean[]) AS t(id, locked, source, override)
            WHERE m.id = t.id AND m.status = 'scheduled'`,
          [keeps.map((k) => k.id), version, keeps.map((k) => k.room.locked), keeps.map((k) => k.room.source), keeps.map((k) => k.room.override)],
        );
      }
      if (inserts.length > 0) {
        // Two people sorted into A and B, a third in C, as every other writer stores a room.
        const sorted = inserts.map((i) => [...i.room.userIds].sort());
        await client.query(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, status,
                                reason_tags, match_reason, locked, schedule_version, assignment_source, is_override)
           SELECT $1::uuid, t.round_number, t.a, t.b, t.c, 'scheduled', '{}'::text[], 'published_schedule',
                  t.locked, $2::int, t.source, t.override
             FROM unnest($3::int[], $4::uuid[], $5::uuid[], $6::uuid[], $7::boolean[], $8::text[], $9::boolean[])
               AS t(round_number, a, b, c, locked, source, override)`,
          [
            sessionId, version, inserts.map((i) => i.round), sorted.map((s) => s[0]), sorted.map((s) => s[1]),
            sorted.map((s) => s[2] ?? null), inserts.map((i) => i.room.locked), inserts.map((i) => i.room.source),
            inserts.map((i) => i.room.override),
          ],
        );
      }
    });
  }
  if (refusedRooms.length > 0) {
    logger.warn({ sessionId, version, refusedRooms }, 'Published rooms the checker now refuses were not written to the live event');
  }
  return { changedRooms: inserts.map((i) => ({ round: i.round, room: i.room.room })), refusedRooms };
}

/** The planned rounds as the engine's output reads, for the host's plan strip and the Start log. */
async function plannedOutput(sessionId: string, startedAt: number): Promise<MatchingOutput> {
  const rows = (await query<{ round_number: number; a: string; b: string; c: string | null }>(
    `SELECT round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches
      WHERE session_id = $1 AND status = 'scheduled' AND is_manual = FALSE
      ORDER BY round_number, created_at`,
    [sessionId],
  )).rows;
  const byRound = new Map<number, RoundAssignment>();
  for (const m of rows) {
    const round = byRound.get(m.round_number) ?? { roundNumber: m.round_number, pairs: [], byeParticipant: null };
    round.pairs.push({
      participantAId: m.a, participantBId: m.b, ...(m.c && { participantCId: m.c }), score: 0, reasonTags: [], matchReason: 'published_schedule',
    });
    byRound.set(m.round_number, round);
  }
  const rounds = [...byRound.values()].sort((x, y) => x.roundNumber - y.roundNumber);
  return {
    sessionId,
    rounds,
    generatedAt: new Date(),
    durationMs: Date.now() - startedAt,
    metadata: {
      participantCount: new Set(rows.flatMap((m) => [m.a, m.b, m.c].filter(Boolean))).size,
      roundCount: rounds.length, avgScore: 0, minScore: 0, duplicatesAvoided: 0,
    },
  };
}

interface Place { user_id: string; status: string }

async function placesOf(sessionId: string): Promise<Place[]> {
  return (await query<Place>(
    `SELECT user_id, status::text AS status FROM session_participants WHERE session_id = $1`, [sessionId],
  )).rows;
}

/** Everyone a version seats in rounds >= `fromRound` (in a room of two or more). */
function seatedFrom(snapshot: ScheduleSnapshot, fromRound: number): Set<string> {
  return new Set(snapshot.rounds.filter((r) => r.round >= fromRound)
    .flatMap((r) => r.rooms.filter((room) => room.userIds.length >= 2).flatMap((room) => room.userIds)));
}

/**
 * Who a live change concerns, from the latest version and the event's places now. Departed: someone the version seats
 * in a round from `fromRound` on who is no longer to be matched (removed, left, did not come, now running the event),
 * or, when who is in the room is known (`present` not empty), is not there. Arrived (only when who is in the room is
 * known): someone there, to be matched, whom the version does not seat in every one of those rounds, or whom the
 * product had marked absent. Without presence nobody is counted as arrived, so repairs with and without it never undo
 * each other.
 */
async function liveChange(
  sessionId: string, snapshot: ScheduleSnapshot, fromRound: number, hostIds: Set<string>, present?: Set<string>,
): Promise<{ departed: string[]; arrived: string[] }> {
  const places = await placesOf(sessionId);
  const status = new Map(places.map((p) => [p.user_id, p.status]));
  const known = !!present && present.size > 0;
  const matchable = (id: string) => !hostIds.has(id) && !NOT_MATCHABLE.has(status.get(id) ?? 'removed');
  const seated = seatedFrom(snapshot, fromRound);
  const departed = [...seated].filter((id) => !matchable(id) || (known && !present!.has(id))).sort();
  if (!known) return { departed, arrived: [] };
  const open = snapshot.rounds.filter((r) => r.round >= fromRound);
  const seatedEvery = (id: string) => open.every((r) => r.rooms.some((room) => room.userIds.length >= 2 && room.userIds.includes(id)));
  const marked = new Set((await query<{ user_id: string }>(
    `SELECT user_id FROM event_schedule_absences WHERE session_id = $1 AND created_by IS NULL`, [sessionId],
  )).rows.map((r) => r.user_id));
  const arrived = places.map((p) => p.user_id)
    .filter((id) => matchable(id) && present!.has(id) && (marked.has(id) || !seatedEvery(id)))
    .sort();
  return { departed, arrived };
}

/**
 * Start (handleHostStart) for an event with a published version, instead of the engine's plan: every round of the
 * latest version is written into `matches` (planned, with its locks, version and how each room was seated), then
 * anyone it seats who is not there (`presentUserIds`, when known) or no longer to be matched, and anyone there it
 * does not seat, is repaired in through repairAffectedRounds (an automatic version; only their rooms change).
 */
export async function materialisePublished(
  sessionId: string, opts: { presentUserIds?: Set<string>; hostIds: string[] },
): Promise<MatchingOutput> {
  const startedAt = Date.now();
  const version = await latestVersion(sessionId);
  if (version === null) throw new Error('materialisePublished: the event has no published schedule');
  await materialiseRounds(sessionId, version, 1, { onlyChangedRooms: false });
  const snapshot = await readSnapshot(readerOf(), sessionId, version);
  if (snapshot) {
    const change = await liveChange(sessionId, snapshot, 1, new Set(opts.hostIds), opts.presentUserIds);
    if (change.departed.length > 0 || change.arrived.length > 0) {
      await repairAffectedRounds(sessionId, 1, change, change.departed.length > 0 ? 'left' : 'late_joiner');
    }
  }
  return plannedOutput(sessionId, startedAt);
}

/**
 * After an organiser's publish while the event is live: the rooms that changed in the rounds not yet started are
 * rewritten, under the match-generation lock every other live match write takes, and every screen showing the plan
 * is told. Never throws (the version is already published; the next repair or Start writes it again).
 */
export async function materialiseAfterPublish(sessionId: string, version: number): Promise<void> {
  try {
    const changed = await withMatchGenerationLock(sessionId, async () => {
      const current = await query<{ current_round: number | null }>(`SELECT current_round FROM sessions WHERE id = $1`, [sessionId]);
      return materialiseRounds(sessionId, version, (current.rows[0]?.current_round ?? 0) + 1, { onlyChangedRooms: true });
    });
    await announcePlanChanged(sessionId, changed.changedRooms);
  } catch (err) {
    logger.warn({ err, sessionId, version }, 'A live publish could not be written to the live matches (non-fatal)');
  }
}

/** The host's plan strip and every plan screen follow a rewrite of the live plan. */
async function announcePlanChanged(sessionId: string, changedRooms: ChangedRoom[]): Promise<void> {
  if (changedRooms.length === 0) return;
  const io = getRealtimeIo();
  if (!io) return;
  io.to(`session:${sessionId}`).emit('host:event_plan_repaired', {
    sessionId, reason: 'host_request', regeneratedRounds: [...new Set(changedRooms.map((c) => c.round))].sort((a, b) => a - b),
  });
  const audience = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
     UNION SELECT host_user_id AS user_id FROM sessions WHERE id = $1 AND host_user_id IS NOT NULL`,
    [sessionId],
  );
  await emitEntities(io, audience.rows.map((r) => r.user_id), [E.session(sessionId), E.sessionPlan(sessionId)]);
}

// ─── Repairing the live event through the board ──────────────────────────────

/** The host and co-hosts are told, on their live dashboard, that a locked meeting lost someone. */
function tellHostsOfLosses(sessionId: string, hostIds: Iterable<string>, losses: Array<{ round: number; name: string }>): void {
  const io = getRealtimeIo();
  if (!io || losses.length === 0) return;
  for (const hostId of hostIds) {
    for (const loss of losses) {
      io.to(`user:${hostId}`).emit('host:action_confirmed', {
        sessionId,
        action: 'schedule_locked_vacancy',
        summary: `A locked meeting in round ${loss.round} lost ${loss.name}.`,
        target: null,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

/**
 * Someone arrived or left the live event (or the host asked for the rest of the plan again): edit the draft for the
 * rounds from `fromRound` on that have not started, publish an automatic version, and rewrite only the rooms that
 * changed (untouched `matches` rows keep their ids). Spec 07: missing participants recalculate only the affected
 * unlocked assignments.
 *   - departed: marked absent by the product from `fromRound` on (unless already absent then), and taken out of every
 *     unlocked room; their partners join the round's basket. A locked meeting (or a locked seat) that loses someone
 *     keeps them and its other people, shows the gap, and the host is told "A locked meeting in round {n} lost
 *     {name}."; nobody is moved into it.
 *   - arrived: an absence the product set ends; they join the baskets.
 *   - an unlocked room the checker now refuses (a block or a regroup since) gives its people back to the basket.
 *   - each round's basket is seated again (redistributeRound): seated people never move.
 * The caller holds the match-generation lock (live repairs run under it).
 */
export async function repairAffectedRounds(
  sessionId: string, fromRound: number, change: { departed: string[]; arrived: string[] }, reason: RepairReason,
): Promise<{ version: number | null; changedRooms: ChangedRoom[] }> {
  const prep = await prepareWrite(sessionId, true);
  let losses: Array<{ round: number; name: string }> = [];
  let hostIds: Set<string> = new Set();
  const outcome = await withLockedDraft(sessionId, prep, null, async (locked): Promise<PublishedVersion | null> => {
    const { state } = locked;
    hostIds = state.hostIds;
    if (isEnded(state) || state.publishedVersion === null) return null;
    const rounds = Array.from({ length: state.numberOfRounds }, (_, i) => i + 1).filter((r) => r >= fromRound && isEditable(state, r));
    if (rounds.length === 0) return null;
    const draft = cloneDraft(state.draft);
    const lost: Array<{ round: number; name: string }> = [];

    for (const id of change.arrived) {
      if (draft.absences.get(id)?.automatic) draft.absences.delete(id);
    }
    for (const id of change.departed) {
      const alreadyAbsent = rounds.every((r) => absentIn(draft, id, r));
      if (!alreadyAbsent) draft.absences.set(id, { kind: 'no_show', fromRound: rounds[0], toRound: null, automatic: true });
      for (const round of rounds) {
        const at = seatOf(draft, round, id);
        if (!at) continue;
        if (at.seat.slotLocked || draft.locks.has(lockKey(round, at.room))) {
          if (!alreadyAbsent) lost.push({ round, name: nameOf(state, id) });
          continue;
        }
        removeSeat(draft, round, id);
        // A partner left alone joins the basket, so the round seats them again (in a trio, or with someone waiting).
        const rest = roomsOf(draft, round).get(at.room) ?? [];
        if (rest.length === 1 && !rest[0].slotLocked) removeSeat(draft, round, rest[0].userId);
      }
    }
    for (const round of rounds) {
      const ctx = roomCheckContextFor(state.base, round, pairsOutside(draft, round, 'earlier'));
      const rooms = roomsOf(draft, round);
      for (const [room, seats] of rooms) {
        if (draft.locks.has(lockKey(round, room))) continue;
        const verdict = checkRoom(ctx, seats.map((s) => s.userId), { override: seats.some((s) => s.override), fallback: true });
        if (verdict.ok) continue;
        rooms.set(room, seats.filter((s) => s.slotLocked));
      }
      setRooms(draft, round, rooms);
    }

    const seatedBefore = new Map(rounds.map((round) => [round, seatKeys(roomsOf(draft, round))]));
    await redistribute(state, draft, rounds, seatingNeeds(state, prep));
    for (const round of rounds) {
      splitTriosForTheWaiting(state, draft, round);
      markRepairSeats(roomsOf(draft, round), seatedBefore.get(round)!);
    }

    const done = await commitDraft(locked, draft, {
      action: 'schedule.edited', round: fromRound, generated: false, reason,
      after: { op: 'live_repair', fromRound, departed: change.departed, arrived: change.arrived },
    }, { actorId: null, automatic: true });
    losses = lost;
    if (!done || (state.published && sameSnapshot(snapshotOf(state, draft), state.published))) return null;
    return publishLocked(locked, draft, { actorId: null, automatic: true, reason, note: null });
  });
  tellHostsOfLosses(sessionId, hostIds, losses);
  if (outcome.stale || !outcome.value) return { version: null, changedRooms: [] };
  const published = outcome.value;
  await announcePublished(sessionId, published);
  const { changedRooms } = await materialiseRounds(sessionId, published.version, fromRound, { onlyChangedRooms: true });
  logger.info({ sessionId, fromRound, reason, version: published.version, changedRooms: changedRooms.length }, 'Live schedule repaired through the board');
  return { version: published.version, changedRooms };
}

/**
 * Someone still waiting after the basket was seated, while an unlocked meeting of three could give up one person:
 * that person and the one waiting meet in a new room, when the checker passes both rooms. Redistribution never moves
 * a seated person, so without this a leaver's partner could wait a whole round beside two trios. A locked meeting or a
 * locked seat is never split.
 */
function splitTriosForTheWaiting(state: BoardState, draft: Draft, round: number): void {
  const rooms = roomsOf(draft, round);
  const seated = new Set([...rooms.values()].flat().map((s) => s.userId));
  const waiting = [...state.people.keys()].filter((id) => autoSeatable(state, draft, id, round) && !seated.has(id));
  if (waiting.length === 0) return;
  const ctx = roomCheckContextFor(state.base, round, pairsOutside(draft, round, 'earlier'));
  const ok = (ids: string[]) => checkRoom(ctx, ids, { fallback: true }).ok;
  for (const id of waiting) {
    const trios = [...rooms].filter(([room, seats]) => seats.length === 3 && !draft.locks.has(lockKey(round, room))).sort((a, b) => a[0] - b[0]);
    found: for (const [room, seats] of trios) {
      for (const seat of seats) {
        if (seat.slotLocked) continue;
        const rest = seats.filter((s) => s !== seat);
        if (!ok(rest.map((s) => s.userId)) || !ok([seat.userId, id])) continue;
        const lockedNumbers = [...draft.locks].filter((k) => Number(k.split(':')[0]) === round).map((k) => Number(k.split(':')[1]));
        const next = Math.max(0, ...rooms.keys(), ...lockedNumbers) + 1;
        rooms.set(room, rest);
        rooms.set(next, [seat, { userId: id, slotLocked: false, source: 'repair', override: false, fallback: false }]);
        break found;
      }
    }
  }
  setRooms(draft, round, rooms);
}

const seatKeys = (rooms: Rooms) => new Set([...rooms].flatMap(([room, seats]) => seats.map((s) => `${room}:${s.userId}`)));

/** A seat the repair made (not there before it) reads as seated by a repair, not by the engine. */
function markRepairSeats(rooms: Rooms, before: Set<string>): void {
  for (const [room, seats] of rooms) {
    rooms.set(room, seats.map((s): Seat => (before.has(`${room}:${s.userId}`) || s.source !== 'auto' ? s : { ...s, source: 'repair' })));
  }
}

/**
 * repairFutureRounds for an event with a published version: who departed and arrived is worked out from the latest
 * version, the event's places now and, when known, who is in the room; then repairAffectedRounds. Answers in
 * repairFutureRounds' shape: the rounds whose rooms changed.
 */
export async function repairPublishedFromLive(
  sessionId: string, fromRound: number, reason: RepairReason, hostIds: string[], presentUserIds?: Set<string>,
): Promise<{ regeneratedRounds: number[]; errors: Array<{ roundNumber: number; error: string }> }> {
  const version = await latestVersion(sessionId);
  const snapshot = version === null ? null : await readSnapshot(readerOf(), sessionId, version);
  if (!snapshot) return { regeneratedRounds: [], errors: [] };
  const change = await liveChange(sessionId, snapshot, fromRound, new Set(hostIds), presentUserIds);
  const { changedRooms } = await repairAffectedRounds(sessionId, fromRound, change, reason);
  return { regeneratedRounds: [...new Set(changedRooms.map((c) => c.round))].sort((a, b) => a - b), errors: [] };
}

// ─── The host's live actions on a board event ───────────────────────────────

/** Whether any of these matches is locked on the board (live swap and exclude refuse it). */
export async function anyMatchLocked(matchIds: string[]): Promise<boolean> {
  if (matchIds.length === 0) return false;
  const result = await query<{ locked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM matches WHERE id = ANY($1::uuid[]) AND locked) AS locked`, [matchIds],
  );
  return result.rows[0]?.locked === true;
}

/** The people of a round's locked planned meetings: Re-match keeps their rooms and leaves them out of the engine. */
export async function lockedPeopleInRound(sessionId: string, round: number): Promise<string[]> {
  const result = await query<{ a: string; b: string | null; c: string | null }>(
    `SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches
      WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled' AND locked`,
    [sessionId, round],
  );
  return [...new Set(result.rows.flatMap(membersOf))];
}

/**
 * When a round starts: a planned row written from a published version whose room the checker now refuses (someone
 * blocked or reported the other, or was regrouped, after it was written) is cancelled instead of started, and its
 * people wait this round. Rows the engine made live are not read: an event without a version is untouched.
 */
export async function refuseBrokenScheduledRooms(sessionId: string, round: number): Promise<string[]> {
  const rows = (await query<{ id: string; a: string; b: string | null; c: string | null; is_override: boolean }>(
    `SELECT id, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, is_override FROM matches
      WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled' AND schedule_version IS NOT NULL`,
    [sessionId, round],
  )).rows;
  if (rows.length === 0) return [];
  const ctx = roomCheckContextFor(await loadEventCheckBase(sessionId), round, new Set());
  const broken = rows.filter((m) => !checkRoom(ctx, membersOf(m), { override: m.is_override, fallback: true }).ok).map((m) => m.id);
  if (broken.length > 0) {
    await query(`UPDATE matches SET status = 'cancelled', ended_at = NOW() WHERE id = ANY($1::uuid[]) AND status = 'scheduled'`, [broken]);
    logger.warn({ sessionId, round, cancelled: broken.length }, 'Planned rooms the checker now refuses were not started');
  }
  return broken;
}

/**
 * After the host confirms a round of a board event (handleHostConfirmRound): the round as it actually started (the
 * host may have swapped, excluded or re-matched it live) is written back into the draft, and a manual version is
 * published (reason 'live_edit'), so the board and the live event agree. A room that started as the board had it
 * keeps its number and lock; a new room takes the next number. Nothing happens for an event without a version, or
 * when the round started exactly as published.
 */
export async function syncRoundIntoSchedule(sessionId: string, round: number, actorId: string): Promise<void> {
  if (!(await hasPublishedSchedule(sessionId))) return;
  const started = (await query<{ a: string; b: string | null; c: string | null }>(
    `SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c FROM matches
      WHERE session_id = $1 AND round_number = $2 AND status IN ('active', 'completed') AND is_manual = FALSE`,
    [sessionId, round],
  )).rows.map(membersOf).filter((m) => m.length >= 2);
  const prep = await prepareWrite(sessionId, false);
  const outcome = await withLockedDraft(sessionId, prep, null, async (locked): Promise<PublishedVersion | null> => {
    const { state } = locked;
    if (state.publishedVersion === null || round > state.numberOfRounds) return null;
    const draft = cloneDraft(state.draft);
    const current = roomsOf(draft, round);
    const byComposition = new Map([...current].map(([room, seats]) => [compositionKey(seats.map((s) => s.userId)), room]));
    let nextNumber = Math.max(0, ...current.keys(),
      ...[...draft.locks].filter((k) => Number(k.split(':')[0]) === round).map((k) => Number(k.split(':')[1])));
    const next: Rooms = new Map();
    for (const members of started) {
      const room = byComposition.get(compositionKey(members));
      if (room !== undefined) {
        next.set(room, current.get(room)!);
        continue;
      }
      nextNumber += 1;
      next.set(nextNumber, members.map((userId): Seat => ({ userId, slotLocked: false, source: 'manual', override: false, fallback: false })));
    }
    // The round has started: a lock on a room it did not keep has nothing left to hold.
    for (const key of [...draft.locks]) {
      const [r, room] = key.split(':').map(Number);
      if (r === round && !next.has(room)) draft.locks.delete(key);
    }
    draft.rounds.delete(round);
    setRooms(draft, round, next);
    const done = await commitDraft(locked, draft, {
      action: 'schedule.edited', round, generated: false, reason: 'live_edit', after: { op: 'live_round_confirmed' },
    }, { actorId, automatic: false });
    if (!done || (state.published && sameSnapshot(snapshotOf(state, draft), state.published))) return null;
    return publishLocked(locked, draft, { actorId, automatic: false, reason: 'live_edit', note: null });
  });
  if (outcome.stale || !outcome.value) return;
  await announcePublished(sessionId, outcome.value);
  const current = await query<{ current_round: number | null }>(`SELECT current_round FROM sessions WHERE id = $1`, [sessionId]);
  const { changedRooms } = await materialiseRounds(
    sessionId, outcome.value.version, Math.max(round, current.rows[0]?.current_round ?? 0) + 1, { onlyChangedRooms: true },
  );
  await announcePlanChanged(sessionId, changedRooms);
}
