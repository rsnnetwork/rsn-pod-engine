// ─── The matching board's draft (10 Nov 2026 spec, Part 2 Task 8; sections 06, 07, 12, 05 curated/hybrid) ───
//
// An event's organisers plan who meets whom, round by round, on a private draft (migration 140): generate it with
// the engine, move, swap and unassign people, lock a meeting or a seat, seat the basket again, and mark someone
// late or not coming. Publishing the draft as a version, and the live event following it, are Task 9: nothing in
// the live event reads these tables, so an event takes today's path until a version is published.
//
// Rules every write keeps (Key decision D4):
//   - One transaction. The event's `event_schedules` row is locked (SELECT ... FOR UPDATE) and its `revision`
//     compared with the one the organiser's screen was showing: a write made against an older board is refused
//     (409 SCHEDULE_CHANGED) with the board as it is now, so two organisers never overwrite each other. A write
//     that changes something bumps the revision, is audited in the same transaction, and tells the host and
//     co-hosts (session:<id>:schedule; the draft is private, participants are never told).
//   - The basket is never stored: a round's basket is its eligible people (a place in the event that is not
//     removed, not one of the people running it, not marked absent for the round) without a seat. Nobody can be
//     lost by a write, and someone who registers while an organiser edits is in every round's basket at once.
//   - A seat is one row per person per round (UNIQUE), so nobody is ever in two rooms of a round.
//   - A locked meeting keeps its people and its room number through every generate and redistribute; a locked seat
//     keeps its person. Moving, swapping or unassigning anyone in either is refused until it is unlocked. A locked
//     meeting that loses someone (marked late, removed from the event) is flagged as a vacancy, never refilled.
//   - Every room a write makes is checked by the one room checker (shared/src/events/room-check.ts). A group-rule
//     refusal can be overridden by the event's owner or a super admin, recorded on the seat and in the audit row.
//   - A person whose groups change, or who leaves the event, is never moved by it: their room's verdict and
//     status show the problem until an organiser acts.

import type { PoolClient, QueryResultRow } from 'pg';
import {
  BOARD_BASKET_ROOM, ErrorCodes, checkRoom, checkRound, estimatedRoundStarts, explainRoundCapacity, isEventFormat,
  liveKindOf, roundRuleSentence,
  type BoardOp, type BoardOpResult, type ErrorCode, type BoardPerson, type BoardPersonStatus, type BoardRefusal, type BoardRoom,
  type BoardRound, type BoardSeatSource, type RoomCheckContext, type RoomProblem, type RoomVerdict, type ScheduleBoard,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { canActAsHost } from '../roles/effective-role.service';
import type { Actor } from '../roles/actor';
import { getAllHostIds } from '../session/host-set';
import { isLiveStatus } from '../session/main-room';
import { FORMER_MEMBER_NAME } from '../users/active-member';
import { loadEventCheckBase, roomCheckContextFor, type EventCheckBase } from '../matching/constraint-context';
import { pairKey } from '../matching/matching.interface';
import { prepareBoardRoundGenerator, type BoardRoundGenerator } from '../matching/matching.service';
import { mayOverrideGroupRules, OVERRIDE_FORBIDDEN_MESSAGE } from '../matching/live-room-guard';
import { emitEventAuditChanged, recordEventAudit, type EventAuditAction } from '../audit/event-audit';
import { fanoutScheduleDraft } from '../../realtime/fanout';
import { redistributeRound, type WaitingReason } from './redistribute';

// ─── Words the organiser reads ───────────────────────────────────────────────

const NOT_FOUND = "We couldn't find that event.";
const ORGANISERS_ONLY = 'Only the people running this event can plan its meetings.';
const NO_ROUNDS = 'This event has no rounds, so there are no meetings to plan.';
const ENDED = "This event has ended, so its meetings can't change.";
const STALE = 'The board changed while you were editing. It is up to date now; try again.';
const LOCKED = 'This meeting is locked. Unlock it first.';
const ROUND_STARTED = 'This round has already started.';
const NOT_A_ROUND = "That round isn't part of this event.";
const ROOM_FULL = 'A meeting holds at most three people.';
const BASKET_NOTE = 'Leave them in the basket';
/** Rooms offered as alternatives to a refused move; the basket is offered after them. */
const MAX_ROOM_ALTERNATIVES = 4;
const DEFAULT_ROUNDS = 5;

// ─── The draft in memory ─────────────────────────────────────────────────────

interface Seat {
  userId: string;
  slotLocked: boolean;
  source: BoardSeatSource;
  override: boolean;
  fallback: boolean;
}
/** Room number → its seats, in seat order. */
type Rooms = Map<number, Seat[]>;
interface Absence { kind: 'late' | 'no_show'; fromRound: number; toRound: number | null }
interface Draft {
  rounds: Map<number, Rooms>;
  /** `${round}:${room}` of each locked meeting. */
  locks: Set<string>;
  absences: Map<string, Absence>;
}

interface PersonFacts {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** session_participants.status, or null for someone seated who has no place in the event at all. */
  participantStatus: string | null;
}

interface BoardState {
  sessionId: string;
  hostUserId: string;
  status: string;
  currentRound: number;
  numberOfRounds: number;
  roundStarts: Array<string | null>;
  revision: number;
  publishedVersion: number | null;
  draft: Draft;
  /** The event's people in registration order, then anyone seated who no longer has a place. */
  people: Map<string, PersonFacts>;
  hostIds: Set<string>;
  base: EventCheckBase;
}

const lockKey = (round: number, room: number) => `${round}:${room}`;

type Reader = <R extends QueryResultRow>(text: string, params: unknown[]) => Promise<{ rows: R[] }>;
const readerOf = (client?: PoolClient): Reader =>
  client ? (text, params) => client.query(text, params) : (text, params) => query(text, params);

// ─── Reading ─────────────────────────────────────────────────────────────────

interface EventRow {
  host_user_id: string;
  status: string;
  current_round: number | null;
  config: unknown;
  scheduled_at: string | Date | null;
  event_format: string | null;
}
interface ScheduleRow { revision: number; published_version: number | null }

function configOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

async function readEvent(read: Reader, sessionId: string): Promise<EventRow> {
  const result = await read<EventRow>(
    `SELECT host_user_id, status, current_round, config, scheduled_at, event_format FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const event = result.rows[0];
  if (!event) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  return event;
}

function assertRoundsEvent(event: EventRow): void {
  const format = isEventFormat(event.event_format) ? event.event_format : 'speed_networking';
  if (liveKindOf(format) !== 'rounds') throw new ConflictError(ErrorCodes.NOT_A_ROUNDS_EVENT, NO_ROUNDS);
}

/** An unknown event reads as unknown to everyone (before who is asking is looked at); then organisers only. */
async function requireOrganiser(sessionId: string, actor: Actor): Promise<void> {
  const exists = await query<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, [sessionId]);
  if (!exists.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const { allowed } = await canActAsHost(actor.userId, actor.role, sessionId);
  if (!allowed) throw new ForbiddenError(ORGANISERS_ONLY);
}

async function readDraft(read: Reader, sessionId: string): Promise<Draft> {
  const [seats, locks, absences] = await Promise.all([
    read<{ round_number: number; room_number: number; user_id: string; slot_locked: boolean; source: BoardSeatSource; override: boolean; fallback: boolean }>(
      `SELECT round_number, room_number, user_id, slot_locked, source, override, fallback
         FROM event_schedule_assignments WHERE session_id = $1
        ORDER BY round_number, room_number, created_at, user_id`,
      [sessionId],
    ),
    read<{ round_number: number; room_number: number }>(
      `SELECT round_number, room_number FROM event_schedule_room_locks WHERE session_id = $1`, [sessionId],
    ),
    read<{ user_id: string; kind: 'late' | 'no_show'; from_round: number; to_round: number | null }>(
      `SELECT user_id, kind, from_round, to_round FROM event_schedule_absences WHERE session_id = $1`, [sessionId],
    ),
  ]);
  const rounds = new Map<number, Rooms>();
  for (const s of seats.rows) {
    const rooms = rounds.get(s.round_number) ?? new Map<number, Seat[]>();
    const room = rooms.get(s.room_number) ?? [];
    room.push({ userId: s.user_id, slotLocked: s.slot_locked, source: s.source, override: s.override, fallback: s.fallback });
    rooms.set(s.room_number, room);
    rounds.set(s.round_number, rooms);
  }
  return {
    rounds,
    locks: new Set(locks.rows.map((l) => lockKey(l.round_number, l.room_number))),
    absences: new Map(absences.rows.map((a) => [a.user_id, { kind: a.kind, fromRound: a.from_round, toRound: a.to_round }])),
  };
}

interface PersonRow { user_id: string; status: string | null; display_name: string | null; avatar_url: string | null; active: boolean }

async function readPeople(read: Reader, sessionId: string, seated: string[]): Promise<Map<string, PersonFacts>> {
  const toFacts = (r: PersonRow): PersonFacts => ({
    userId: r.user_id,
    displayName: r.active && r.display_name?.trim() ? r.display_name.trim() : FORMER_MEMBER_NAME,
    avatarUrl: r.active ? r.avatar_url : null,
    participantStatus: r.status,
  });
  const places = await read<PersonRow>(
    `SELECT sp.user_id, sp.status::text AS status, u.display_name, u.avatar_url, (u.status = 'active') AS active
       FROM session_participants sp JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = $1
      ORDER BY sp.created_at, sp.user_id`,
    [sessionId],
  );
  const people = new Map(places.rows.map((r) => [r.user_id, toFacts(r)]));
  const placeless = seated.filter((id) => !people.has(id));
  if (placeless.length > 0) {
    const others = await read<PersonRow>(
      `SELECT id AS user_id, NULL::text AS status, display_name, avatar_url, (status = 'active') AS active
         FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [placeless],
    );
    for (const r of others.rows) people.set(r.user_id, toFacts(r));
  }
  return people;
}

const seatedIds = (draft: Draft) => [...new Set([...draft.rounds.values()].flatMap((rooms) => [...rooms.values()].flat().map((s) => s.userId)))];

/** Everything the board is worked out from. With a client, inside the caller's transaction. */
async function loadState(sessionId: string, client?: PoolClient, schedule?: ScheduleRow): Promise<BoardState> {
  const read = readerOf(client);
  const event = await readEvent(read, sessionId);
  assertRoundsEvent(event);
  const row = schedule ?? (await read<ScheduleRow>(
    `SELECT revision, published_version FROM event_schedules WHERE session_id = $1`, [sessionId],
  )).rows[0];
  const draft = await readDraft(read, sessionId);
  const people = await readPeople(read, sessionId, seatedIds(draft));
  const hostIds = new Set(await getAllHostIds(sessionId, event.host_user_id));
  const base = await loadEventCheckBase(sessionId, { client });
  const config = configOf(event.config);
  const numberOfRounds = Math.max(1, Math.floor(Number(config.numberOfRounds) || DEFAULT_ROUNDS));
  return {
    sessionId,
    hostUserId: event.host_user_id,
    status: event.status,
    currentRound: event.current_round ?? 0,
    numberOfRounds,
    roundStarts: estimatedRoundStarts(event.scheduled_at, {
      numberOfRounds,
      roundDurationSeconds: Number(config.roundDurationSeconds) || 0,
      ratingWindowSeconds: Number(config.ratingWindowSeconds) || 0,
    }),
    revision: row?.revision ?? 0,
    publishedVersion: row?.published_version ?? null,
    draft,
    people,
    hostIds,
    base,
  };
}

// ─── Who is where ────────────────────────────────────────────────────────────

const PRESENT = new Set(['checked_in', 'in_lobby', 'in_round']);
const GONE = new Set(['left', 'no_show']);

const isEnded = (state: BoardState) => state.status === 'completed' || state.status === 'cancelled';

/** Started rounds of a live event, every round of an ended one, and rounds the event no longer has are not edited. */
function isEditable(state: BoardState, round: number): boolean {
  if (isEnded(state) || round > state.numberOfRounds) return false;
  return !(isLiveStatus(state.status) && round <= state.currentRound);
}

/** Someone to match: a place that is not removed, and not one of the people running the event. */
function inEvent(state: BoardState, userId: string): boolean {
  const status = state.people.get(userId)?.participantStatus;
  return !!status && status !== 'removed' && !state.hostIds.has(userId);
}

function absentIn(draft: Draft, userId: string, round: number): boolean {
  const a = draft.absences.get(userId);
  return !!a && a.fromRound <= round && (a.toRound === null || round <= a.toRound);
}

const eligibleIn = (state: BoardState, draft: Draft, userId: string, round: number) =>
  inEvent(state, userId) && !absentIn(draft, userId, round);

/** The person's standing, in a round (seats and baskets) or for the whole event (`round` null). */
function statusOf(state: BoardState, draft: Draft, userId: string, round: number | null): BoardPersonStatus {
  if (!inEvent(state, userId)) return 'not_in_event';
  if (round === null ? draft.absences.has(userId) : absentIn(draft, userId, round)) return 'absent';
  const status = state.people.get(userId)?.participantStatus ?? '';
  if (PRESENT.has(status)) return 'present';
  if (GONE.has(status)) return 'left';
  return 'registered';
}

function personOf(state: BoardState, draft: Draft, userId: string, round: number | null): BoardPerson {
  const p = state.people.get(userId);
  return {
    userId,
    displayName: p?.displayName ?? FORMER_MEMBER_NAME,
    avatarUrl: p?.avatarUrl ?? null,
    groupKeys: state.base.rules ? state.base.groups.get(userId) ?? [] : [],
    status: statusOf(state, draft, userId, round),
  };
}

const nameOf = (state: BoardState, userId: string) => state.people.get(userId)?.displayName ?? FORMER_MEMBER_NAME;

function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Every round the board shows: the event's rounds, and any round beyond them that still holds seats or locks. */
function roundNumbers(state: BoardState, draft: Draft): number[] {
  let last = state.numberOfRounds;
  for (const r of draft.rounds.keys()) last = Math.max(last, r);
  for (const key of draft.locks) last = Math.max(last, Number(key.split(':')[0]));
  return Array.from({ length: last }, (_, i) => i + 1);
}

const roomsOf = (draft: Draft, round: number): Rooms => draft.rounds.get(round) ?? new Map<number, Seat[]>();

function seatOf(draft: Draft, round: number, userId: string): { room: number; seat: Seat } | null {
  for (const [room, seats] of roomsOf(draft, round)) {
    const seat = seats.find((s) => s.userId === userId);
    if (seat) return { room, seat };
  }
  return null;
}

function addRoomPairs(into: Set<string>, members: string[]): void {
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) into.add(pairKey(members[i], members[j]));
}

/** Pairs the draft makes meet in rounds other than `round` (`earlier`: only before it). */
function pairsOutside(draft: Draft, round: number, which: 'earlier' | 'all'): Set<string> {
  const pairs = new Set<string>();
  for (const [r, rooms] of draft.rounds) {
    if (r === round || (which === 'earlier' && r > round)) continue;
    for (const seats of rooms.values()) addRoomPairs(pairs, seats.map((s) => s.userId));
  }
  return pairs;
}

/** How many meetings each person has in the draft's other rounds. */
function meetingsCounter(draft: Draft, round: number): (userId: string) => number {
  const counts = new Map<string, number>();
  for (const [r, rooms] of draft.rounds) {
    if (r === round) continue;
    for (const seats of rooms.values()) {
      if (seats.length < 2) continue;
      for (const s of seats) counts.set(s.userId, (counts.get(s.userId) ?? 0) + 1);
    }
  }
  return (userId) => counts.get(userId) ?? 0;
}

// ─── The board as the organiser reads it ─────────────────────────────────────

function capacityOf(state: BoardState, round: number, eligible: string[]): BoardRound['capacity'] {
  const rules = state.base.rules;
  if (!rules) return null;
  const known = new Set(rules.groups.map((g) => g.key));
  const counts: Record<string, number> = {};
  let ungrouped = 0;
  for (const id of eligible) {
    const keys = (state.base.groups.get(id) ?? []).filter((k) => known.has(k));
    if (keys.length === 0) ungrouped++;
    for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  }
  return explainRoundCapacity(rules, round, counts, Math.max(state.numberOfRounds, round), ungrouped);
}

function buildRound(state: BoardState, draft: Draft, round: number): BoardRound {
  const rooms = roomsOf(draft, round);
  const lockedNumbers = [...draft.locks].filter((k) => Number(k.split(':')[0]) === round).map((k) => Number(k.split(':')[1]));
  const numbers = [...new Set([...rooms.keys(), ...lockedNumbers])].sort((a, b) => a - b);
  const ctx = roomCheckContextFor(state.base, round, pairsOutside(draft, round, 'earlier'));
  const { collisions, verdicts } = checkRound(ctx, numbers.map((roomNumber) => {
    const seats = rooms.get(roomNumber) ?? [];
    return { roomNumber, memberIds: seats.map((s) => s.userId), override: seats.some((s) => s.override), fallback: true };
  }));
  const boardRooms: BoardRoom[] = numbers.map((roomNumber) => {
    const seats = rooms.get(roomNumber) ?? [];
    const verdict = verdicts.get(roomNumber)!;
    // Someone seated who is not to be matched this round (absent, removed, now running the event) leaves a gap.
    const gone = seats.map((s) => s.userId).filter((id) => !eligibleIn(state, draft, id, round));
    if (gone.length > 0) verdict.warnings.push({ kind: 'vacancy', userIds: gone });
    return {
      roomNumber,
      locked: draft.locks.has(lockKey(round, roomNumber)),
      verdict,
      seats: seats.map((s) => ({
        ...personOf(state, draft, s.userId, round), slotLocked: s.slotLocked, source: s.source, override: s.override,
      })),
    };
  });
  const seated = new Set([...rooms.values()].flat().map((s) => s.userId));
  const eligible = [...state.people.keys()].filter((id) => eligibleIn(state, draft, id, round));
  return {
    roundNumber: round,
    startsAt: state.roundStarts[round - 1] ?? null,
    editable: isEditable(state, round),
    rooms: boardRooms,
    basket: eligible.filter((id) => !seated.has(id)).map((id) => personOf(state, draft, id, round)),
    capacity: round > state.numberOfRounds ? null : capacityOf(state, round, eligible),
    collisions,
    ...(round > state.numberOfRounds && { beyondLastRound: true }),
  };
}

function hasContent(draft: Draft): boolean {
  return draft.rounds.size > 0 || draft.locks.size > 0 || draft.absences.size > 0;
}

function buildBoard(state: BoardState, canOverride: boolean): ScheduleBoard {
  const draft = state.draft;
  const seated = new Set(seatedIds(draft));
  const people = [...state.people.keys()].filter((id) => inEvent(state, id) || seated.has(id));
  return {
    sessionId: state.sessionId,
    revision: state.revision,
    publishedVersion: state.publishedVersion,
    // Nothing is published before Task 9: until then a draft differs from "nothing published" once it holds
    // anything. Task 9 compares the draft with the published version's rooms.
    draftDiffersFromPublished: state.publishedVersion === null ? hasContent(draft) : true,
    rounds: roundNumbers(state, draft).map((r) => buildRound(state, draft, r)),
    people: people.map((id) => personOf(state, draft, id, null)),
    groupRules: state.base.rules,
    canOverride,
  };
}

/** The board as it stands, for an organiser of the event. An empty draft has every eligible person in the basket. */
export async function getBoard(sessionId: string, actor: Actor): Promise<ScheduleBoard> {
  await requireOrganiser(sessionId, actor);
  return readBoard(sessionId, actor);
}

async function readBoard(sessionId: string, actor: Actor): Promise<ScheduleBoard> {
  const [state, canOverride] = await Promise.all([loadState(sessionId), mayOverrideGroupRules(sessionId, actor.userId)]);
  return buildBoard(state, canOverride);
}

// ─── Refusals ────────────────────────────────────────────────────────────────

const GROUP_PROBLEMS = new Set<RoomProblem['kind']>(['group_rule', 'no_group']);
const hasWarning = (v: RoomVerdict, kind: string, id: string) => v.warnings.some((w) => w.kind === kind && w.userIds.includes(id));

/** The organiser's sentence for a refused room, naming the person being placed first. */
function problemMessage(state: BoardState, round: number, problem: RoomProblem, mover: string): string {
  const ids = problem.userIds.includes(mover) ? [mover, ...problem.userIds.filter((id) => id !== mover)] : problem.userIds;
  const names = ids.map((id) => nameOf(state, id));
  const rule = state.base.rules ? roundRuleSentence(state.base.rules, round) : '';
  switch (problem.kind) {
    case 'too_many': return ROOM_FULL;
    case 'hard_exclusion': return `${names[0]} and ${names[1]} can't be in the same meeting.`;
    case 'no_group':
      return `${andList(names)} ${names.length === 1 ? "isn't" : "aren't"} in a group yet, so they can't be matched in this round: ${rule}`;
    default: return `${names[0]} and ${names[1]} can't meet in this round: ${rule}`;
  }
}

/** Rooms of the round this person could join instead (the checker passes), first-time meetings first; then the basket. */
function alternativesFor(state: BoardState, draft: Draft, ctx: RoomCheckContext, round: number, userId: string, skip: number[]): BoardRefusal['alternatives'] {
  const rooms: Array<{ room: number; repeat: boolean; others: string[] }> = [];
  for (const [room, seats] of [...roomsOf(draft, round)].sort((a, b) => a[0] - b[0])) {
    if (skip.includes(room) || draft.locks.has(lockKey(round, room))) continue;
    const others = seats.map((s) => s.userId).filter((id) => id !== userId);
    if (others.length === 0 || others.length >= ctx.maxRoomSize) continue;
    const v = checkRoom(ctx, [...others, userId], { fallback: true });
    if (v.ok) rooms.push({ room, repeat: hasWarning(v, 'repeat', userId), others });
  }
  rooms.sort((a, b) => Number(a.repeat) - Number(b.repeat) || a.room - b.room);
  return [
    ...rooms.slice(0, MAX_ROOM_ALTERNATIVES).map((r) => ({
      room: r.room,
      note: `Room ${r.room}, with ${andList(r.others.map((id) => nameOf(state, id)))}${r.repeat ? ' (they have met before)' : ''}`,
    })),
    { room: BOARD_BASKET_ROOM, note: BASKET_NOTE },
  ];
}

function refuse(code: ErrorCode, message: string, alternatives: BoardRefusal['alternatives']): never {
  throw new ConflictError(code, message, { alternatives });
}

interface PlacementCheck { override: boolean; fallback: boolean }

/**
 * Whether `mover` may sit in a room of `members` (them included). A block or a room over three is refused
 * outright; a group problem is refused unless the organiser overrides and may. Refusals carry alternatives.
 */
function checkPlacement(
  state: BoardState, draft: Draft, ctx: RoomCheckContext, round: number, members: string[], mover: string,
  op: { override?: boolean }, canOverride: boolean, skipRooms: number[],
): PlacementCheck {
  const v = checkRoom(ctx, members, { fallback: true });
  const fallback = hasWarning(v, 'same_group_fallback', mover);
  const hard = v.problems.find((p) => !GROUP_PROBLEMS.has(p.kind));
  if (hard) refuse(ErrorCodes.SCHEDULE_RULE, problemMessage(state, round, hard, mover), alternativesFor(state, draft, ctx, round, mover, skipRooms));
  const group = v.problems.find((p) => GROUP_PROBLEMS.has(p.kind));
  if (!group) return { override: false, fallback };
  if (op.override !== true) {
    refuse(ErrorCodes.SCHEDULE_GROUP_RULE, problemMessage(state, round, group, mover), alternativesFor(state, draft, ctx, round, mover, skipRooms));
  }
  if (!canOverride) throw new AppError(403, ErrorCodes.GROUP_OVERRIDE_FORBIDDEN, OVERRIDE_FORBIDDEN_MESSAGE);
  return { override: true, fallback };
}

// ─── Checks every edit makes ─────────────────────────────────────────────────

function requireEditableRound(state: BoardState, round: number): void {
  if (!Number.isInteger(round) || round < 1 || round > state.numberOfRounds) throw new ValidationError(NOT_A_ROUND);
  if (!isEditable(state, round)) throw new ConflictError(ErrorCodes.SCHEDULE_ROUND_STARTED, ROUND_STARTED);
}

function requireMatchable(state: BoardState, draft: Draft, userId: string, round: number): void {
  if (!inEvent(state, userId)) {
    throw new ConflictError(ErrorCodes.SCHEDULE_RULE, `${nameOf(state, userId)} isn't taking part in this event's meetings.`);
  }
  if (absentIn(draft, userId, round)) {
    throw new ConflictError(ErrorCodes.SCHEDULE_RULE, `${nameOf(state, userId)} is marked absent for this round. Clear that first.`);
  }
}

function requireUnlocked(draft: Draft, round: number, at: { room: number; seat: Seat } | null): void {
  if (at && (at.seat.slotLocked || draft.locks.has(lockKey(round, at.room)))) {
    throw new ConflictError(ErrorCodes.SCHEDULE_LOCKED, LOCKED);
  }
}

function cloneDraft(draft: Draft): Draft {
  return {
    rounds: new Map([...draft.rounds].map(([r, rooms]) => [r, new Map([...rooms].map(([room, seats]) => [room, seats.map((s) => ({ ...s }))]))])),
    locks: new Set(draft.locks),
    absences: new Map([...draft.absences].map(([id, a]) => [id, { ...a }])),
  };
}

function setRooms(draft: Draft, round: number, rooms: Rooms): void {
  for (const [room, seats] of rooms) if (seats.length === 0) rooms.delete(room);
  if (rooms.size === 0) draft.rounds.delete(round);
  else draft.rounds.set(round, rooms);
}

function removeSeat(draft: Draft, round: number, userId: string): void {
  const rooms = roomsOf(draft, round);
  for (const [room, seats] of rooms) rooms.set(room, seats.filter((s) => s.userId !== userId));
  setRooms(draft, round, rooms);
}

const manualSeat = (userId: string, check: PlacementCheck): Seat => ({
  userId, slotLocked: false, source: 'manual', override: check.override, fallback: check.fallback,
});

// ─── Seating a basket (generate, redistribute, absences) ─────────────────────

interface SeatingNeeds {
  generator: () => Promise<BoardRoundGenerator>;
}

/**
 * Seat round `round`'s basket into `kept` (its locked meetings and seats, or everything when nothing is cleared).
 * `avoid` are the pairs other rounds already make meet. Rooms whose only people are not to be matched this round
 * are left alone, as locked ones are, so nobody is seated with someone who is not coming.
 */
async function seatBasket(
  state: BoardState, draft: Draft, round: number, kept: Rooms, avoid: Set<string>, needs: SeatingNeeds,
): Promise<{ rooms: Rooms; waiting: Array<{ userId: string; reason: WaitingReason }> }> {
  const seated = new Map([...kept].map(([room, seats]) => [room, seats.map((s) => s.userId)]));
  const lockedRooms = new Set([...kept.keys()].filter((room) =>
    draft.locks.has(lockKey(round, room))
    || kept.get(room)!.every((s) => !eligibleIn(state, draft, s.userId, round))));
  const lockedSlots = new Set([...kept.values()].flat().filter((s) => s.slotLocked).map((s) => s.userId));
  const taken = new Set([...seated.values()].flat());
  const basket = [...state.people.keys()].filter((id) => eligibleIn(state, draft, id, round) && !taken.has(id));
  const ctx = roomCheckContextFor(state.base, round, avoid);
  const generate = basket.length >= 2 ? await needs.generator() : null;
  const result = redistributeRound({
    round, seated, lockedRooms, lockedSlots, basket, ctx,
    generate: (people) => (generate ? generate(people, round, avoid) : { roundNumber: round, pairs: [], byeParticipant: null }),
    meetingsOf: meetingsCounter(draft, round),
  });
  const rooms: Rooms = new Map();
  for (const [room, members] of result.seated) {
    const keptSeats = new Map((kept.get(room) ?? []).map((s) => [s.userId, s]));
    const verdict = checkRoom(ctx, members, { fallback: true });
    rooms.set(room, members.map((id) => keptSeats.get(id) ?? {
      userId: id, slotLocked: false, source: 'auto', override: false, fallback: hasWarning(verdict, 'same_group_fallback', id),
    }));
  }
  return { rooms, waiting: result.waiting };
}

/** Seat the basket of each round again without clearing anything (12/08). */
async function redistribute(state: BoardState, draft: Draft, rounds: number[], needs: SeatingNeeds): Promise<number> {
  let waiting = 0;
  for (const round of rounds) {
    const seated = await seatBasket(state, draft, round, roomsOf(draft, round), pairsOutside(draft, round, 'all'), needs);
    setRooms(draft, round, seated.rooms);
    waiting += seated.waiting.length;
  }
  return waiting;
}

function scopeRounds(state: BoardState, rounds: number[] | 'all'): number[] {
  if (rounds === 'all') {
    return Array.from({ length: state.numberOfRounds }, (_, i) => i + 1).filter((r) => isEditable(state, r));
  }
  const unique = [...new Set(rounds)].sort((a, b) => a - b);
  for (const r of unique) requireEditableRound(state, r);
  return unique;
}

/**
 * Generate (section 07, "locks across regeneration"): for each round in scope, ascending, keep the locked meetings
 * and locked seats, clear the rest, and seat everyone else with the engine. Every locked meeting of every round is
 * avoided first, so a locked meeting in round 4 is not repeated in round 2. 'all' also clears rounds the event no
 * longer has.
 */
async function generate(state: BoardState, draft: Draft, rounds: number[] | 'all', needs: SeatingNeeds): Promise<{ scope: number[]; waiting: number }> {
  const scope = scopeRounds(state, rounds);
  if (rounds === 'all') {
    for (const r of [...draft.rounds.keys()]) if (r > state.numberOfRounds) draft.rounds.delete(r);
    for (const key of [...draft.locks]) if (Number(key.split(':')[0]) > state.numberOfRounds) draft.locks.delete(key);
  }
  const keptOf = (round: number): Rooms => {
    const kept: Rooms = new Map();
    for (const [room, seats] of roomsOf(draft, round)) {
      const keep = draft.locks.has(lockKey(round, room)) ? seats : seats.filter((s) => s.slotLocked);
      if (keep.length > 0) kept.set(room, keep);
    }
    return kept;
  };
  // Clear first, so a round still to be generated only counts its locked meetings in what the others avoid.
  for (const round of scope) setRooms(draft, round, keptOf(round));
  let waiting = 0;
  for (const round of scope) {
    const seated = await seatBasket(state, draft, round, roomsOf(draft, round), pairsOutside(draft, round, 'all'), needs);
    setRooms(draft, round, seated.rooms);
    waiting += seated.waiting.length;
  }
  return { scope, waiting };
}

/**
 * Someone is absent for `rounds` (marked late or not coming): their seats there that are not locked empty and those
 * rounds' baskets are seated again; a locked seat or meeting keeps them, and its room shows the vacancy.
 */
async function vacate(state: BoardState, draft: Draft, userId: string, needs: SeatingNeeds): Promise<void> {
  const touched: number[] = [];
  for (const round of roundNumbers(state, draft)) {
    if (!isEditable(state, round) || !absentIn(draft, userId, round)) continue;
    const at = seatOf(draft, round, userId);
    if (!at || at.seat.slotLocked || draft.locks.has(lockKey(round, at.room))) continue;
    removeSeat(draft, round, userId);
    touched.push(round);
  }
  await redistribute(state, draft, touched, needs);
}

// ─── The edits ───────────────────────────────────────────────────────────────

interface Decision {
  action: EventAuditAction;
  round: number | null;
  generated: boolean;
  reason?: string;
  after: Record<string, unknown>;
}

async function applyOp(
  state: BoardState, draft: Draft, op: BoardOp, canOverride: boolean, needs: SeatingNeeds,
): Promise<Decision> {
  const edited = (round: number | null, after: Record<string, unknown> = {}): Decision => ({
    action: 'schedule.edited', round, generated: false, reason: op.reason, after: { op: op.kind, ...after },
  });
  switch (op.kind) {
    case 'move': {
      requireEditableRound(state, op.round);
      requireMatchable(state, draft, op.userId, op.round);
      const from = seatOf(draft, op.round, op.userId);
      if (from?.room === op.toRoom) return edited(op.round);
      requireUnlocked(draft, op.round, from);
      if (draft.locks.has(lockKey(op.round, op.toRoom))) throw new ConflictError(ErrorCodes.SCHEDULE_LOCKED, LOCKED);
      const ctx = roomCheckContextFor(state.base, op.round, pairsOutside(draft, op.round, 'earlier'));
      const target = (roomsOf(draft, op.round).get(op.toRoom) ?? []).map((s) => s.userId);
      const skip = from ? [from.room, op.toRoom] : [op.toRoom];
      const check = checkPlacement(state, draft, ctx, op.round, [...target, op.userId], op.userId, op, canOverride, skip);
      removeSeat(draft, op.round, op.userId);
      const rooms = roomsOf(draft, op.round);
      rooms.set(op.toRoom, [...(rooms.get(op.toRoom) ?? []), manualSeat(op.userId, check)]);
      setRooms(draft, op.round, rooms);
      return edited(op.round, { toRoom: op.toRoom, override: check.override });
    }
    case 'swap': {
      requireEditableRound(state, op.round);
      requireMatchable(state, draft, op.userId, op.round);
      const a = seatOf(draft, op.round, op.userId);
      const b = seatOf(draft, op.round, op.withUserId);
      if (!b) throw new ConflictError(ErrorCodes.SCHEDULE_RULE, `${nameOf(state, op.withUserId)} has no seat in this round.`);
      if (a && a.room === b.room) return edited(op.round);
      if (a) requireMatchable(state, draft, op.withUserId, op.round);
      requireUnlocked(draft, op.round, a);
      requireUnlocked(draft, op.round, b);
      const ctx = roomCheckContextFor(state.base, op.round, pairsOutside(draft, op.round, 'earlier'));
      const rooms = roomsOf(draft, op.round);
      const skip = a ? [a.room, b.room] : [b.room];
      // A takes B's seat; B takes A's, or the basket when A came from it. Both stay assigned when both were.
      const roomB = rooms.get(b.room)!.map((s) => s.userId).map((id) => (id === op.withUserId ? op.userId : id));
      const checkA = checkPlacement(state, draft, ctx, op.round, roomB, op.userId, op, canOverride, skip);
      let checkB: PlacementCheck | null = null;
      if (a) {
        const roomA = rooms.get(a.room)!.map((s) => s.userId).map((id) => (id === op.userId ? op.withUserId : id));
        checkB = checkPlacement(state, draft, ctx, op.round, roomA, op.withUserId, op, canOverride, skip);
      }
      rooms.set(b.room, rooms.get(b.room)!.map((s) => (s.userId === op.withUserId ? manualSeat(op.userId, checkA) : s)));
      if (a && checkB) rooms.set(a.room, rooms.get(a.room)!.map((s) => (s.userId === op.userId ? manualSeat(op.withUserId, checkB!) : s)));
      setRooms(draft, op.round, rooms);
      return edited(op.round, { withUserId: op.withUserId, override: checkA.override || !!checkB?.override });
    }
    case 'unassign': {
      requireEditableRound(state, op.round);
      const at = seatOf(draft, op.round, op.userId);
      if (!at) return edited(op.round);
      requireUnlocked(draft, op.round, at);
      removeSeat(draft, op.round, op.userId);
      return edited(op.round, { fromRoom: at.room });
    }
    case 'lock_room':
    case 'unlock_room': {
      requireEditableRound(state, op.round);
      const key = lockKey(op.round, op.room);
      if (op.kind === 'lock_room') {
        if (!roomsOf(draft, op.round).has(op.room)) throw new ValidationError("There's no meeting in that room to lock.");
        draft.locks.add(key);
      } else {
        draft.locks.delete(key);
      }
      return { action: op.kind === 'lock_room' ? 'schedule.locked' : 'schedule.unlocked', round: op.round, generated: false, after: { op: op.kind, room: op.room } };
    }
    case 'lock_slot':
    case 'unlock_slot': {
      requireEditableRound(state, op.round);
      const at = seatOf(draft, op.round, op.userId);
      if (!at) throw new ValidationError(`${nameOf(state, op.userId)} has no seat in this round.`);
      at.seat.slotLocked = op.kind === 'lock_slot';
      return { action: op.kind === 'lock_slot' ? 'schedule.locked' : 'schedule.unlocked', round: op.round, generated: false, after: { op: op.kind, room: at.room } };
    }
    case 'redistribute': {
      const scope = scopeRounds(state, op.rounds);
      const waiting = await redistribute(state, draft, scope, needs);
      return edited(scope.length === 1 ? scope[0] : null, { rounds: scope, waiting });
    }
    case 'mark_late': {
      if (!inEvent(state, op.userId)) throw new ConflictError(ErrorCodes.SCHEDULE_RULE, `${nameOf(state, op.userId)} isn't taking part in this event's meetings.`);
      if (!Number.isInteger(op.fromRound) || op.fromRound < 2 || op.fromRound > state.numberOfRounds) {
        throw new ValidationError("Choose the round they'll arrive for, from round 2 on.");
      }
      draft.absences.set(op.userId, { kind: 'late', fromRound: 1, toRound: op.fromRound - 1 });
      await vacate(state, draft, op.userId, needs);
      return edited(null, { userId: op.userId, arrivesForRound: op.fromRound });
    }
    case 'mark_no_show': {
      if (!inEvent(state, op.userId)) throw new ConflictError(ErrorCodes.SCHEDULE_RULE, `${nameOf(state, op.userId)} isn't taking part in this event's meetings.`);
      const fromRound = isLiveStatus(state.status) ? state.currentRound + 1 : 1;
      draft.absences.set(op.userId, { kind: 'no_show', fromRound, toRound: null });
      await vacate(state, draft, op.userId, needs);
      return edited(null, { userId: op.userId, absentFromRound: fromRound });
    }
    case 'clear_absence': {
      draft.absences.delete(op.userId);
      return edited(null, { userId: op.userId });
    }
    default: {
      const unknown: never = op;
      throw new ValidationError(`That change isn't one the board knows: ${String((unknown as { kind?: string }).kind)}`);
    }
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

const seatSignature = (room: number, s: Seat) => `${room}|${s.slotLocked}|${s.source}|${s.override}|${s.fallback}`;

function signaturesOf(rooms: Rooms | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [room, seats] of rooms ?? []) {
    for (const s of seats) out.set(s.userId, seatSignature(room, s));
  }
  return out;
}

/** Per round, the people whose seat changed (moved, came, went, or a flag on it changed). */
function changedSeats(before: Draft, after: Draft): Array<{ round: number; userIds: string[] }> {
  const rounds = [...new Set([...before.rounds.keys(), ...after.rounds.keys()])].sort((a, b) => a - b);
  const changed: Array<{ round: number; userIds: string[] }> = [];
  for (const round of rounds) {
    const a = signaturesOf(before.rounds.get(round));
    const b = signaturesOf(after.rounds.get(round));
    const userIds = [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id)).sort();
    if (userIds.length > 0) changed.push({ round, userIds });
  }
  return changed;
}

const sameAbsence = (a?: Absence, b?: Absence) => !!a && !!b && a.kind === b.kind && a.fromRound === b.fromRound && a.toRound === b.toRound;

/** Writes what changed between the two drafts: whole rounds rewritten, locks and absences one by one. */
async function persist(client: PoolClient, sessionId: string, actorId: string, before: Draft, after: Draft, rounds: number[]): Promise<void> {
  if (rounds.length > 0) {
    await client.query(
      `DELETE FROM event_schedule_assignments WHERE session_id = $1 AND round_number = ANY($2::int[])`,
      [sessionId, rounds],
    );
    const cols: [number[], number[], string[], boolean[], string[], boolean[], boolean[]] = [[], [], [], [], [], [], []];
    for (const round of rounds) {
      for (const [room, seats] of roomsOf(after, round)) {
        for (const s of seats) {
          cols[0].push(round); cols[1].push(room); cols[2].push(s.userId); cols[3].push(s.slotLocked);
          cols[4].push(s.source); cols[5].push(s.override); cols[6].push(s.fallback);
        }
      }
    }
    if (cols[0].length > 0) {
      await client.query(
        `INSERT INTO event_schedule_assignments (session_id, round_number, room_number, user_id, slot_locked, source, override, fallback)
         SELECT $1::uuid, t.round_number, t.room_number, t.user_id, t.slot_locked, t.source, t.override, t.fallback
           FROM unnest($2::int[], $3::int[], $4::uuid[], $5::boolean[], $6::text[], $7::boolean[], $8::boolean[])
             AS t(round_number, room_number, user_id, slot_locked, source, override, fallback)`,
        [sessionId, ...cols],
      );
    }
  }
  const added = [...after.locks].filter((k) => !before.locks.has(k));
  const removed = [...before.locks].filter((k) => !after.locks.has(k));
  const split = (keys: string[]) => [keys.map((k) => Number(k.split(':')[0])), keys.map((k) => Number(k.split(':')[1]))];
  if (added.length > 0) {
    await client.query(
      `INSERT INTO event_schedule_room_locks (session_id, round_number, room_number, locked_by)
       SELECT $1::uuid, t.round_number, t.room_number, $4::uuid FROM unnest($2::int[], $3::int[]) AS t(round_number, room_number)
       ON CONFLICT (session_id, round_number, room_number) DO NOTHING`,
      [sessionId, ...split(added), actorId],
    );
  }
  if (removed.length > 0) {
    await client.query(
      `DELETE FROM event_schedule_room_locks l USING unnest($2::int[], $3::int[]) AS t(round_number, room_number)
        WHERE l.session_id = $1 AND l.round_number = t.round_number AND l.room_number = t.room_number`,
      [sessionId, ...split(removed)],
    );
  }
  for (const [userId, a] of after.absences) {
    if (sameAbsence(a, before.absences.get(userId))) continue;
    await client.query(
      `INSERT INTO event_schedule_absences (session_id, user_id, kind, from_round, to_round, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, user_id) DO UPDATE
         SET kind = EXCLUDED.kind, from_round = EXCLUDED.from_round, to_round = EXCLUDED.to_round, created_by = EXCLUDED.created_by`,
      [sessionId, userId, a.kind, a.fromRound, a.toRound, actorId],
    );
  }
  for (const userId of before.absences.keys()) {
    if (after.absences.has(userId)) continue;
    await client.query(`DELETE FROM event_schedule_absences WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]);
  }
}

function draftsEqual(a: Draft, b: Draft): boolean {
  if (changedSeats(a, b).length > 0) return false;
  if (a.locks.size !== b.locks.size || [...a.locks].some((k) => !b.locks.has(k))) return false;
  if (a.absences.size !== b.absences.size) return false;
  return [...a.absences].every(([id, x]) => sameAbsence(x, b.absences.get(id)));
}

type WriteOutcome =
  | { stale: true }
  | { stale: false; changed: Array<{ round: number; userIds: string[] }>; wrote: boolean };

/**
 * One board write: lock the event's schedule row, compare the revision, change the draft in memory, write what
 * changed, bump the revision and audit in the same transaction; then tell the organisers and answer with the board.
 */
async function writeBoard(
  sessionId: string, actor: Actor, expectedRevision: number,
  decide: (state: BoardState, draft: Draft, canOverride: boolean, needs: SeatingNeeds) => Promise<Decision>,
): Promise<BoardOpResult> {
  await requireOrganiser(sessionId, actor);
  const canOverride = await mayOverrideGroupRules(sessionId, actor.userId);
  const outcome = await transaction(async (client): Promise<WriteOutcome> => {
    await client.query(`INSERT INTO event_schedules (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING`, [sessionId]);
    const locked = await client.query<ScheduleRow>(
      `SELECT revision, published_version FROM event_schedules WHERE session_id = $1 FOR UPDATE`, [sessionId],
    );
    const schedule = locked.rows[0];
    if (!schedule || schedule.revision !== expectedRevision) return { stale: true };
    const state = await loadState(sessionId, client, schedule);
    if (isEnded(state)) throw new ConflictError(ErrorCodes.EVENT_ENDED, ENDED);
    const draft = cloneDraft(state.draft);
    let generator: BoardRoundGenerator | null = null;
    const needs: SeatingNeeds = {
      generator: async () => {
        generator ??= await prepareBoardRoundGenerator(sessionId, [...state.people.keys()].filter((id) => inEvent(state, id)));
        return generator;
      },
    };
    const decision = await decide(state, draft, canOverride, needs);
    if (draftsEqual(state.draft, draft) && !decision.generated) return { stale: false, changed: [], wrote: false };
    const changed = changedSeats(state.draft, draft);
    await persist(client, sessionId, actor.userId, state.draft, draft, changed.map((c) => c.round));
    const bumped = await client.query<{ revision: number }>(
      `UPDATE event_schedules
          SET revision = revision + 1, updated_by = $2, updated_at = NOW(),
              generated_at = CASE WHEN $3::boolean THEN NOW() ELSE generated_at END
        WHERE session_id = $1
        RETURNING revision`,
      [sessionId, actor.userId, decision.generated],
    );
    await recordEventAudit({
      sessionId,
      actorId: actor.userId,
      action: decision.action,
      automatic: false,
      round: decision.round,
      subjectUserIds: [...new Set(changed.flatMap((c) => c.userIds))],
      before: { revision: state.revision },
      after: { ...decision.after, revision: bumped.rows[0]?.revision ?? state.revision + 1, changed },
      ...(decision.reason && { reason: decision.reason }),
    }, client);
    return { stale: false, changed, wrote: true };
  });
  if (outcome.stale) {
    const board = await readBoard(sessionId, actor);
    throw new ConflictError(ErrorCodes.SCHEDULE_CHANGED, STALE, { board });
  }
  if (outcome.wrote) {
    void fanoutScheduleDraft(sessionId, actor.userId);
    void emitEventAuditChanged(sessionId);
  }
  return { board: await readBoard(sessionId, actor), changed: outcome.changed };
}

/**
 * Generate the board's rounds with the engine (all, or the ones named): locked meetings and seats stay, the rest is
 * cleared and seated again, everyone the rules leave without a partner waits in the basket.
 */
export async function generateBoard(
  sessionId: string, actor: Actor, expectedRevision: number, rounds: number[] | 'all',
): Promise<BoardOpResult> {
  return writeBoard(sessionId, actor, expectedRevision, async (state, draft, _canOverride, needs) => {
    const { scope, waiting } = await generate(state, draft, rounds, needs);
    return { action: 'schedule.generated', round: scope.length === 1 ? scope[0] : null, generated: true, after: { rounds: scope, waiting } };
  });
}

/** One edit to the board: move, swap, unassign, lock or unlock, redistribute, or mark someone late or not coming. */
export async function applyBoardOp(sessionId: string, actor: Actor, expectedRevision: number, op: BoardOp): Promise<BoardOpResult> {
  return writeBoard(sessionId, actor, expectedRevision, (state, draft, canOverride, needs) =>
    applyOp(state, draft, op, canOverride, needs));
}
