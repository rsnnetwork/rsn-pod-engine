// ─── The live event following the published schedule (10 Nov 2026 spec, Part 2 Task 9; sections 07, 12/10) ─────
//
// Key decision D4, one schedule pipeline: for an event with a published version, the live `matches` table is always
// the latest version written out for the rounds not yet started. It is written
//   - at Start (materialisePublished, instead of the engine's plan), every round of the latest version, and then
//     anyone the version seats who is not there, or anyone there it does not seat, is repaired in;
//   - after every publish while the event is live (materialiseAfterPublish), only the rooms that changed;
//   - after every automatic repair (repairAffectedRounds) and every confirmed round written back
//     (syncRoundIntoSchedule), each of which publishes its own version.
// A round with an active or completed match is never rewritten, a room's `matches` row that the new version keeps
// keeps its id, and a version older than the latest is never written (a late writer cannot undo a newer version).
// Every room written is checked by the one room checker with today's blocks, reports, invites and groups, so a block or
// a regroup made after the version was published is never seated through it (the host is told), and when a round
// starts the rows written from a version are checked once more (refuseBrokenScheduledRooms).
//
// Spec 07: draft changes stay private until published, and missing participants recalculate only the affected
// unlocked assignments. So the live repairs start from the LATEST PUBLISHED version, never from the organisers' draft:
// they change only the rooms the arrival or departure touches, publish that as an automatic version (checked, bells to
// the people whose meetings changed), and then apply the same room changes to the draft. Where the draft already had
// its own changes in those rooms, the draft keeps them and the board flags the round for the organiser
// (event_schedules.live_conflicts) until an organiser publishes.
//
// Locks survive every live repair: someone leaving a locked meeting keeps their seat, the meeting is flagged and the
// host told, and nobody is moved into it; Re-match keeps the round's locked meetings, and a live swap or exclude
// refuses them.
//
// An event with no published version takes today's path untouched: every entry point asks hasPublishedSchedule first,
// one indexed read, and the callers keep their own code for the answer "no". When that read fails, a second check asks
// whether any of the event's live matches came from a published schedule: none (every event without a board) takes
// today's path as before; some, or a second failure, abandons the operation (its caller logs it, and the next tick or
// the host's retry asks again), so an event with locked meetings is never run down today's path by mistake.

import {
  checkRoom,
  type MatchingOutput, type PublishPreviewItem, type RoundAssignment, type ScheduleSnapshot, type ScheduleSnapshotRoom,
} from '@rsn/shared';
import type { PoolClient } from 'pg';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { loadEventCheckBase, roomCheckContextFor } from '../matching/constraint-context';
import type { BoardRoundGenerator } from '../matching/matching.service';
import { withMatchGenerationLock } from '../orchestration/state/session-state';
import { getAllHostIds } from '../session/host-set';
import {
  absentIn, andList, autoSeatable, cloneDraft, commitDraft, isEditable, isEnded, lockKey, meetingsCounter, nameOf,
  pairsOutside, prepareWrite, readSnapshot, readerOf, removeSeat, roomsOf, sameSnapshot, seatOf, setRooms, snapshotOf,
  withLockedDraft,
  type BoardState, type Draft, type Rooms, type Seat,
} from './schedule-board.service';
import { announcePublished, previewItems, publishLocked, type PublishedVersion } from './schedule-publish.service';
import { redistributeRound } from './redistribute';

export type RepairReason = 'late_joiner' | 'left' | 'host_request';
export type ChangedRoom = { round: number; room: number };

/** Statuses of a place that is not someone to match now. */
const NOT_MATCHABLE = new Set(['removed', 'left', 'no_show']);
const LOCKED_MATCH = 'This meeting is locked on the matching board.';
export { LOCKED_MATCH as LOCKED_MATCH_MESSAGE };

// ─── Is the event on the board? ──────────────────────────────────────────────

/**
 * Whether the event has a published schedule version: the one question every live entry point asks before taking the
 * board's path. An event without board rows answers no and takes today's path. If the read fails, the event's live
 * matches are checked for rows written from a published schedule: with none it answers no (today's path, unchanged);
 * with some, or if that check fails too, it throws and the caller abandons the operation (each live caller logs it,
 * and its retry or next tick asks again).
 */
export async function hasPublishedSchedule(sessionId: string): Promise<boolean> {
  try {
    return (await latestVersion(sessionId)) !== null;
  } catch (err) {
    // The read failed. What matters is whether running today's path could disturb a published schedule: only an event
    // whose live matches were written from one (a locked meeting, a row carrying its version) could be. Asked
    // separately; an event with no such row takes today's path exactly as before the board existed.
    let boardRows: boolean;
    try {
      boardRows = await hasBoardMatches(sessionId);
    } catch (checkErr) {
      logger.warn({ err, checkErr, sessionId }, 'Schedule reads failed: the operation is abandoned until the next try');
      throw err;
    }
    if (boardRows) {
      logger.warn({ err, sessionId }, 'The published schedule could not be read for an event that follows one: the operation is abandoned until the next try');
      throw err;
    }
    logger.warn({ err, sessionId }, 'The published schedule could not be read; the event has no board rows, so it takes the path without a schedule');
    return false;
  }
}

/** Whether any of the event's live matches came from a published schedule (locked, or carrying a version). */
async function hasBoardMatches(sessionId: string): Promise<boolean> {
  const result = await query<{ board: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM matches WHERE session_id = $1 AND (locked OR schedule_version IS NOT NULL)) AS board`,
    [sessionId],
  );
  return result.rows[0]?.board === true;
}

async function latestVersion(sessionId: string): Promise<number | null> {
  const result = await query<{ published_version: number | null }>(
    `SELECT published_version FROM event_schedules WHERE session_id = $1`, [sessionId],
  );
  return result.rows[0]?.published_version ?? null;
}

// ─── Telling the host ────────────────────────────────────────────────────────

/** The host and co-hosts see these on their live dashboard (the existing host:action_confirmed event). */
async function warnHosts(sessionId: string, action: string, summaries: string[], hostIds?: Iterable<string>): Promise<void> {
  const io = getRealtimeIo();
  if (!io || summaries.length === 0) return;
  try {
    let hosts = hostIds ? [...hostIds] : null;
    if (!hosts) {
      const event = await query<{ host_user_id: string }>(`SELECT host_user_id FROM sessions WHERE id = $1`, [sessionId]);
      hosts = event.rows[0] ? await getAllHostIds(sessionId, event.rows[0].host_user_id) : [];
    }
    for (const hostId of hosts) {
      for (const summary of summaries) {
        io.to(`user:${hostId}`).emit('host:action_confirmed', {
          sessionId, action, summary, target: null, timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId, action }, 'The hosts could not be told about a schedule problem (non-fatal)');
  }
}

async function namesOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const result = await query<{ id: string; display_name: string | null }>(
    `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [userIds],
  );
  return new Map(result.rows.map((r) => [r.id, (r.display_name ?? '').trim() || 'Someone']));
}

/** "Round 2: Ann and Ben can't meet now, so their meeting was not set up." for each refused room. */
async function refusedSentences(rooms: Array<{ round: number; userIds: string[] }>, what: string): Promise<string[]> {
  const names = await namesOf([...new Set(rooms.flatMap((r) => r.userIds))]);
  return rooms.map((r) => `Round ${r.round}: ${andList(r.userIds.map((id) => names.get(id) ?? 'Someone'))} can't meet now, so their meeting ${what}.`);
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

export interface Materialised {
  /** Rooms of the version written as new rows. */
  changedRooms: ChangedRoom[];
  /** Every round whose planned rows changed: a room added, removed, or its lock or override changed. */
  changedRounds: number[];
  /** Rooms of the version the checker now refuses: not written, and the host is told. */
  refusedRooms: ChangedRoom[];
}

const NOTHING: Materialised = { changedRooms: [], changedRounds: [], refusedRooms: [] };

/**
 * Write rounds >= `fromRound` of version `version` into `matches`. Nothing is written when a newer version exists: the
 * newer one is (or will be) written by its own publisher, and an older one must never undo it. A round with any
 * match that has started is left alone, and so is a round the version does not have (a bonus round the host added
 * live). In the others, every planned row (status 'scheduled', not a host's breakout) whose room the version no longer
 * has is deleted, every room of the version that has no row is inserted, and a row whose room the version keeps stays,
 * with its id (its lock, version, source and override are brought up to date). With `onlyChangedRooms` false every
 * planned row of those rounds is replaced. A room of fewer than two people is not a meeting and is not written; a room
 * the checker now refuses (a block, a report, an invite, a group rule without an override) is not written either, and
 * the host is told.
 */
export async function materialiseRounds(
  sessionId: string, version: number, fromRound: number, opts: { onlyChangedRooms: boolean },
): Promise<Materialised> {
  const latest = await latestVersion(sessionId);
  if (latest !== null && version < latest) {
    logger.info({ sessionId, version, latest }, 'A newer schedule version exists: the older one is not written to the live event');
    return NOTHING;
  }
  const snapshot = await readSnapshot(readerOf(), sessionId, version);
  if (!snapshot) return NOTHING;
  const rows = (await query<MatchRow>(
    `SELECT id, round_number, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, status::text AS status,
            is_manual, locked, schedule_version, assignment_source, is_override
       FROM matches WHERE session_id = $1 AND round_number >= $2`,
    [sessionId, fromRound],
  )).rows;
  const rounds = snapshot.rounds.filter((r) => r.round >= fromRound);
  const base = await loadEventCheckBase(sessionId);

  const removals: MatchRow[] = [];
  const keeps: Keep[] = [];
  const inserts: Insert[] = [];
  const refused: Array<{ round: number; room: number; userIds: string[] }> = [];
  const changedRounds = new Set<number>();
  for (const { round, rooms } of rounds) {
    const roundRows = rows.filter((m) => m.round_number === round && !m.is_manual);
    if (roundRows.some((m) => STARTED(m.status))) continue;
    const planned = roundRows.filter((m) => m.status === 'scheduled');
    const ctx = roomCheckContextFor(base, round, new Set());
    const wanted = rooms.filter((room) => {
      if (room.userIds.length < 2) return false;
      const ok = checkRoom(ctx, room.userIds, { override: room.override, fallback: true }).ok;
      if (!ok) refused.push({ round, room: room.room, userIds: room.userIds });
      return ok;
    });
    if (!opts.onlyChangedRooms) {
      removals.push(...planned);
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
      if (!row) {
        inserts.push({ round, room });
        continue;
      }
      keeps.push({ id: row.id, room });
      if (row.locked !== room.locked || row.is_override !== room.override) changedRounds.add(round);
    }
    for (const left of byComposition.values()) removals.push(...left);
  }
  for (const m of removals) changedRounds.add(m.round_number);
  for (const i of inserts) changedRounds.add(i.round);

  if (removals.length > 0 || keeps.length > 0 || inserts.length > 0) {
    await transaction(async (client) => {
      if (removals.length > 0) {
        await client.query(`DELETE FROM matches WHERE id = ANY($1::uuid[]) AND status = 'scheduled'`, [removals.map((m) => m.id)]);
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
  if (refused.length > 0) {
    logger.warn({ sessionId, version, refused }, 'Published rooms the checker now refuses were not written to the live event');
    await warnHosts(sessionId, 'schedule_room_refused', await refusedSentences(refused, 'was not set up'));
  }
  return {
    changedRooms: inserts.map((i) => ({ round: i.round, room: i.room.room })),
    changedRounds: [...changedRounds].sort((a, b) => a - b),
    refusedRooms: refused.map(({ round, room }) => ({ round, room })),
  };
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
 * After an organiser's publish while the event is live: under the match-generation lock every other live match write
 * takes, the LATEST version (read inside the lock, so a repair that published a newer one while this waited is never
 * undone) is written for the rounds not yet started, and every screen showing the plan is told. Never throws (the
 * version is already published; the next repair or Start writes it again).
 */
export async function materialiseAfterPublish(sessionId: string): Promise<void> {
  try {
    const written = await withMatchGenerationLock(sessionId, async () => {
      const version = await latestVersion(sessionId);
      if (version === null) return NOTHING;
      const current = await query<{ current_round: number | null }>(`SELECT current_round FROM sessions WHERE id = $1`, [sessionId]);
      return materialiseRounds(sessionId, version, (current.rows[0]?.current_round ?? 0) + 1, { onlyChangedRooms: true });
    });
    await announcePlanChanged(sessionId, written.changedRounds);
  } catch (err) {
    logger.warn({ err, sessionId }, 'A live publish could not be written to the live matches (non-fatal)');
  }
}

/** The host's plan strip and every plan screen follow a rewrite of the live plan (rooms added or removed). */
async function announcePlanChanged(sessionId: string, changedRounds: number[]): Promise<void> {
  if (changedRounds.length === 0) return;
  const io = getRealtimeIo();
  if (!io) return;
  io.to(`session:${sessionId}`).emit('host:event_plan_repaired', {
    sessionId, reason: 'host_request', regeneratedRounds: changedRounds,
  });
  const audience = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
     UNION SELECT host_user_id AS user_id FROM sessions WHERE id = $1 AND host_user_id IS NOT NULL`,
    [sessionId],
  );
  await emitEntities(io, audience.rows.map((r) => r.user_id), [E.session(sessionId), E.sessionPlan(sessionId)]);
}

// ─── Editing the published version (never the draft) ────────────────────────

/**
 * The latest version as a draft the live repair edits: its rooms and room locks. Seat locks and absences are the
 * board's (a version does not carry them): a seat locked on the board in the same room stays locked, and who is marked
 * late or absent is what the board says.
 */
function publishedAsDraft(state: BoardState, snapshot: ScheduleSnapshot): Draft {
  const rounds = new Map<number, Rooms>();
  const locks = new Set<string>();
  for (const r of snapshot.rounds) {
    const rooms: Rooms = new Map();
    for (const room of r.rooms) {
      if (room.locked) locks.add(lockKey(r.round, room.room));
      if (room.userIds.length === 0) continue;
      rooms.set(room.room, room.userIds.map((userId): Seat => {
        const onBoard = seatOf(state.draft, r.round, userId);
        return {
          userId, slotLocked: !!onBoard && onBoard.room === room.room && onBoard.seat.slotLocked,
          source: room.source, override: room.override, fallback: room.fallback,
        };
      }));
    }
    if (rooms.size > 0) rounds.set(r.round, rooms);
  }
  return { rounds, locks, absences: new Map([...state.draft.absences].map(([id, a]) => [id, { ...a }])) };
}

/**
 * Seat `basket` (the people this change left without a meeting in `round`) into the round without moving anyone else
 * (redistributeRound): rooms of one and locked rooms are left alone, the rest of the basket is paired by the engine,
 * and anyone left joins an unlocked pair when the checker allows it. Anyone still waiting may take one person out of an
 * unlocked trio into a new pair. A seat this makes reads as made by a repair.
 */
function seatAffected(
  state: BoardState, work: Draft, round: number, basket: Set<string>, generator: BoardRoundGenerator | null,
): void {
  const rooms = roomsOf(work, round);
  const seated = new Map([...rooms].map(([n, seats]) => [n, seats.map((s) => s.userId)]));
  for (const key of work.locks) {
    const [r, n] = key.split(':').map(Number);
    if (r === round && !seated.has(n)) seated.set(n, []);
  }
  const lockedRooms = new Set([...seated.keys()].filter((n) => work.locks.has(lockKey(round, n)) || seated.get(n)!.length < 2));
  const lockedSlots = new Set([...rooms.values()].flat().filter((s) => s.slotLocked).map((s) => s.userId));
  const taken = new Set([...seated.values()].flat());
  const people = [...basket].filter((id) => autoSeatable(state, work, id, round) && !taken.has(id));
  if (people.length === 0) return;
  const avoid = pairsOutside(work, round, 'all');
  const ctx = roomCheckContextFor(state.base, round, avoid);
  const result = redistributeRound({
    round, seated, lockedRooms, lockedSlots, basket: people, ctx,
    generate: (group) => (generator && group.length >= 2
      ? generator(group, round, avoid)
      : { roundNumber: round, pairs: [], byeParticipant: null }),
    meetingsOf: meetingsCounter(work, round),
  });
  const next: Rooms = new Map();
  for (const [n, members] of result.seated) {
    const kept = new Map((rooms.get(n) ?? []).map((s) => [s.userId, s]));
    const verdict = checkRoom(ctx, members, { fallback: true });
    next.set(n, members.map((id): Seat => kept.get(id) ?? {
      userId: id, slotLocked: false, source: 'repair', override: false,
      fallback: verdict.warnings.some((w) => w.kind === 'same_group_fallback' && w.userIds.includes(id)),
    }));
  }
  setRooms(work, round, next);
  splitTriosForTheWaiting(state, work, round, people);
}

/**
 * Someone this change left waiting, while an unlocked meeting of three could give up one person: that person and the
 * one waiting meet in a new room, when the checker passes both rooms. A locked meeting or a locked seat is never split.
 */
function splitTriosForTheWaiting(state: BoardState, draft: Draft, round: number, candidates: string[]): void {
  const rooms = roomsOf(draft, round);
  const seated = new Set([...rooms.values()].flat().map((s) => s.userId));
  const waiting = candidates.filter((id) => !seated.has(id) && autoSeatable(state, draft, id, round));
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
        rooms.set(next, [{ ...seat, source: 'repair' }, { userId: id, slotLocked: false, source: 'repair', override: false, fallback: false }]);
        break found;
      }
    }
  }
  setRooms(draft, round, rooms);
}

const seatsKey = (seats: Seat[]) => compositionKey(seats.map((s) => s.userId));

/**
 * Apply to the draft the room changes the live event made to the published version (`before` → `after`) in `rounds`.
 * A round whose changed rooms the draft still holds exactly as published takes the change; a round where the draft
 * already changed one of those rooms, or seated one of those people elsewhere, keeps the draft's own rooms and is
 * returned as a conflict for the board to flag.
 */
function rebaseDraft(state: BoardState, draft: Draft, before: Draft, after: Draft, rounds: number[]): PublishPreviewItem[] {
  const conflicts: PublishPreviewItem[] = [];
  for (const round of rounds) {
    const was = roomsOf(before, round);
    const now = roomsOf(after, round);
    const own = roomsOf(draft, round);
    const removed = [...was.keys()].filter((n) => !now.has(n) || seatsKey(now.get(n)!) !== seatsKey(was.get(n)!));
    const added = [...now.keys()].filter((n) => !was.has(n) || seatsKey(was.get(n)!) !== seatsKey(now.get(n)!));
    if (removed.length === 0 && added.length === 0) continue;
    const people = new Set([...removed.flatMap((n) => was.get(n)!), ...added.flatMap((n) => now.get(n)!)].map((s) => s.userId));
    const untouched = removed.every((n) => own.has(n) && seatsKey(own.get(n)!) === seatsKey(was.get(n)!))
      && added.every((n) => removed.includes(n) || !own.has(n))
      && ![...own].some(([n, seats]) => !removed.includes(n) && seats.some((s) => people.has(s.userId)))
      // A lock the draft added to or took off one of those rooms is the organiser's own change too: never dropped unseen.
      && [...removed, ...added].every((n) => draft.locks.has(lockKey(round, n)) === before.locks.has(lockKey(round, n)));
    if (!untouched) {
      const names = andList([...people].map((id) => nameOf(state, id)).sort());
      conflicts.push({
        round, room: null,
        message: `The live event changed round ${round} (${names}) while this board had its own changes there. The board kept its own: check round ${round} before publishing.`,
      });
      continue;
    }
    for (const n of removed) {
      own.delete(n);
      if (!after.locks.has(lockKey(round, n))) draft.locks.delete(lockKey(round, n));
    }
    for (const n of added) own.set(n, now.get(n)!.map((s) => ({ ...s })));
    setRooms(draft, round, own);
  }
  return conflicts;
}

/** Flags appended for the board; a warning the board already shows for the same round is not added again. */
async function addLiveConflicts(
  client: PoolClient, sessionId: string, existing: PublishPreviewItem[], conflicts: PublishPreviewItem[],
): Promise<void> {
  const seen = new Set(existing.map((c) => `${c.round}|${c.message}`));
  const fresh = conflicts.filter((c) => {
    const key = `${c.round}|${c.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  await client.query(
    `UPDATE event_schedules SET live_conflicts = live_conflicts || $2::jsonb WHERE session_id = $1`,
    [sessionId, JSON.stringify(fresh)],
  );
}

// ─── Repairing the live event ────────────────────────────────────────────────

/**
 * Someone arrived or left the live event (or the host asked for the rest of the plan again): starting from the LATEST
 * PUBLISHED version, change only the rooms the change touches in the rounds from `fromRound` on that have not started,
 * publish that as an automatic version, apply the same room changes to the draft (or flag a conflict where the draft
 * has its own changes there), and rewrite only the rooms that changed in `matches`. Spec 07: draft changes stay private
 * until published, and missing participants recalculate only the affected unlocked assignments.
 *   - departed: marked absent by the product from `fromRound` on (unless already absent then), and taken out of every
 *     unlocked room; a partner left alone joins the round's basket. A locked meeting (or a locked seat) that loses
 *     someone keeps them and its other people, shows the gap, and the host is told "A locked meeting in round {n} lost
 *     {name}."; nobody is moved into it.
 *   - arrived: an absence the product set ends; they join the baskets of the rounds that do not seat them.
 *   - an unlocked room the checker now refuses (a block or a regroup since) gives its people back to the basket.
 *   - each basket is seated without moving anyone else (seatAffected). People already waiting in the version stay so.
 * The version is published only if it changed a room and added no problem the published one did not have (checked
 * with the same list a publish is checked with); bells go to the people whose meetings changed. The caller holds the
 * match-generation lock (live repairs run under it).
 */
export async function repairAffectedRounds(
  sessionId: string, fromRound: number, change: { departed: string[]; arrived: string[] }, reason: RepairReason,
): Promise<{ version: number | null; changedRooms: ChangedRoom[]; changedRounds: number[] }> {
  const prep = await prepareWrite(sessionId, true);
  const notices = { losses: [] as string[], refused: [] as PublishPreviewItem[], hostIds: new Set<string>() };
  const outcome = await withLockedDraft(sessionId, prep, null, async (locked): Promise<PublishedVersion | null> => {
    const { state } = locked;
    notices.hostIds = state.hostIds;
    if (isEnded(state) || !state.published) return null;
    const rounds = Array.from({ length: state.numberOfRounds }, (_, i) => i + 1).filter((r) => r >= fromRound && isEditable(state, r));
    if (rounds.length === 0) return null;
    const work = publishedAsDraft(state, state.published);
    const before = cloneDraft(work);
    const baskets = new Map(rounds.map((r) => [r, new Set<string>()]));

    for (const id of change.arrived) {
      if (work.absences.get(id)?.automatic) work.absences.delete(id);
      for (const round of rounds) if (!seatOf(work, round, id)) baskets.get(round)!.add(id);
    }
    for (const id of change.departed) {
      const alreadyAbsent = rounds.every((r) => absentIn(work, id, r));
      if (!alreadyAbsent) work.absences.set(id, { kind: 'no_show', fromRound: rounds[0], toRound: null, automatic: true });
      for (const round of rounds) {
        const at = seatOf(work, round, id);
        if (!at) continue;
        if (at.seat.slotLocked || work.locks.has(lockKey(round, at.room))) {
          if (!alreadyAbsent) notices.losses.push(`A locked meeting in round ${round} lost ${nameOf(state, id)}.`);
          continue;
        }
        removeSeat(work, round, id);
        const rest = roomsOf(work, round).get(at.room) ?? [];
        if (rest.length === 1 && !rest[0].slotLocked) {
          removeSeat(work, round, rest[0].userId);
          baskets.get(round)!.add(rest[0].userId);
        }
      }
    }
    for (const round of rounds) {
      const ctx = roomCheckContextFor(state.base, round, pairsOutside(work, round, 'earlier'));
      const rooms = roomsOf(work, round);
      for (const [room, seats] of rooms) {
        if (work.locks.has(lockKey(round, room))) continue;
        if (checkRoom(ctx, seats.map((s) => s.userId), { override: seats.some((s) => s.override), fallback: true }).ok) continue;
        rooms.set(room, seats.filter((s) => s.slotLocked));
        for (const s of seats) if (!s.slotLocked) baskets.get(round)!.add(s.userId);
      }
      setRooms(work, round, rooms);
    }
    for (const round of rounds) {
      const basket = baskets.get(round)!;
      if (basket.size > 0) seatAffected(state, work, round, basket, prep.generator);
    }

    const draft = cloneDraft(state.draft);
    draft.absences = new Map([...work.absences].map(([id, a]) => [id, { ...a }]));
    const roomsChanged = !sameSnapshot(snapshotOf(state, work), state.published);
    let conflicts: PublishPreviewItem[] = [];
    if (roomsChanged) {
      const had = new Set(previewItems(state, before).blocking.map((i) => JSON.stringify(i)));
      const added = previewItems(state, work).blocking.filter((i) => !had.has(JSON.stringify(i)));
      if (added.length > 0) {
        // A repair never publishes a problem the version did not have. Nothing is written; the next change tries again.
        notices.refused = added;
        return null;
      }
      conflicts = rebaseDraft(state, draft, before, work, rounds);
    }
    await commitDraft(locked, draft, {
      action: 'schedule.edited', round: fromRound, generated: false, reason,
      after: { op: 'live_repair', fromRound, departed: change.departed, arrived: change.arrived, conflicts: conflicts.length },
    }, { actorId: null, automatic: true });
    if (!roomsChanged) return null;
    const published = await publishLocked(locked, work, { actorId: null, automatic: true, reason, note: null });
    await addLiveConflicts(locked.client, sessionId, state.liveConflicts, conflicts);
    return published;
  });
  await warnHosts(sessionId, 'schedule_locked_vacancy', notices.losses, notices.hostIds);
  if (notices.refused.length > 0) {
    logger.warn({ sessionId, reason, refused: notices.refused }, 'A live repair would have added a problem: nothing was published');
    await warnHosts(sessionId, 'schedule_repair_refused', notices.refused.map((i) => `Round ${i.round}: ${i.message}`), notices.hostIds);
  }
  if (outcome.stale || !outcome.value) return { version: null, changedRooms: [], changedRounds: [] };
  const published = outcome.value;
  await announcePublished(sessionId, published);
  const written = await materialiseRounds(sessionId, published.version, fromRound, { onlyChangedRooms: true });
  logger.info({ sessionId, fromRound, reason, version: published.version, changedRounds: written.changedRounds }, 'Live schedule repaired from the published version');
  return { version: published.version, changedRooms: written.changedRooms, changedRounds: written.changedRounds };
}

/**
 * repairFutureRounds for an event with a published version: who departed and arrived is worked out from the latest
 * version, the event's places now and, when known, who is in the room; then repairAffectedRounds. Answers in
 * repairFutureRounds' shape: every round whose planned rooms changed (added or removed), so its callers tell the plan
 * screens.
 */
export async function repairPublishedFromLive(
  sessionId: string, fromRound: number, reason: RepairReason, hostIds: string[], presentUserIds?: Set<string>,
): Promise<{ regeneratedRounds: number[]; errors: Array<{ roundNumber: number; error: string }> }> {
  const version = await latestVersion(sessionId);
  const snapshot = version === null ? null : await readSnapshot(readerOf(), sessionId, version);
  if (!snapshot) return { regeneratedRounds: [], errors: [] };
  const change = await liveChange(sessionId, snapshot, fromRound, new Set(hostIds), presentUserIds);
  const { changedRounds } = await repairAffectedRounds(sessionId, fromRound, change, reason);
  return { regeneratedRounds: changedRounds, errors: [] };
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
 * blocked or reported the other, or was regrouped, after it was written) is cancelled instead of started, its people
 * wait this round, and the host is told. Rows the engine made live are not read: an event without a version is
 * untouched.
 */
export async function refuseBrokenScheduledRooms(sessionId: string, round: number): Promise<string[]> {
  const rows = (await query<{ id: string; a: string; b: string | null; c: string | null; is_override: boolean }>(
    `SELECT id, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, is_override FROM matches
      WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled' AND schedule_version IS NOT NULL`,
    [sessionId, round],
  )).rows;
  if (rows.length === 0) return [];
  const ctx = roomCheckContextFor(await loadEventCheckBase(sessionId), round, new Set());
  const broken = rows.filter((m) => !checkRoom(ctx, membersOf(m), { override: m.is_override, fallback: true }).ok);
  if (broken.length > 0) {
    await query(`UPDATE matches SET status = 'cancelled', ended_at = NOW() WHERE id = ANY($1::uuid[]) AND status = 'scheduled'`, [broken.map((m) => m.id)]);
    logger.warn({ sessionId, round, cancelled: broken.length }, 'Planned rooms the checker now refuses were not started');
    await warnHosts(sessionId, 'schedule_room_refused',
      await refusedSentences(broken.map((m) => ({ round, userIds: membersOf(m) })), 'was not started'));
  }
  return broken.map((m) => m.id);
}

/**
 * After the host confirms a round of a board event (handleHostConfirmRound): the round as it actually started (the
 * host may have swapped, excluded or re-matched it live) is written onto the LATEST PUBLISHED version and published as
 * a manual version by the confirming host (reason 'live_edit'); nothing else of the draft is published. The same room
 * changes are applied to the draft, or flagged where the draft had its own changes in that round. A room that started
 * as published keeps its number and lock; a new room takes the next number. Nothing happens for an event without a
 * version, or when the round started exactly as published.
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
    if (!state.published || round > state.numberOfRounds) return null;
    const work = publishedAsDraft(state, state.published);
    const before = cloneDraft(work);
    const current = roomsOf(work, round);
    const byComposition = new Map([...current].map(([room, seats]) => [seatsKey(seats), room]));
    let nextNumber = Math.max(0, ...current.keys(),
      ...[...work.locks].filter((k) => Number(k.split(':')[0]) === round).map((k) => Number(k.split(':')[1])));
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
    for (const key of [...work.locks]) {
      const [r, room] = key.split(':').map(Number);
      if (r === round && !next.has(room)) work.locks.delete(key);
    }
    work.rounds.delete(round);
    setRooms(work, round, next);
    if (sameSnapshot(snapshotOf(state, work), state.published)) return null;
    const draft = cloneDraft(state.draft);
    const conflicts = rebaseDraft(state, draft, before, work, [round]);
    await commitDraft(locked, draft, {
      action: 'schedule.edited', round, generated: false, reason: 'live_edit', after: { op: 'live_round_confirmed', conflicts: conflicts.length },
    }, { actorId, automatic: false });
    const published = await publishLocked(locked, work, { actorId, automatic: false, reason: 'live_edit', note: null });
    await addLiveConflicts(locked.client, sessionId, state.liveConflicts, conflicts);
    return published;
  });
  if (outcome.stale || !outcome.value) return;
  await announcePublished(sessionId, outcome.value);
  const current = await query<{ current_round: number | null }>(`SELECT current_round FROM sessions WHERE id = $1`, [sessionId]);
  const written = await materialiseRounds(
    sessionId, outcome.value.version, Math.max(round, current.rows[0]?.current_round ?? 0) + 1, { onlyChangedRooms: true },
  );
  await announcePlanChanged(sessionId, written.changedRounds);
}
