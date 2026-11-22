// ─── The matching board, read for the screen (10 Nov 2026 spec, Part 2 Task 13; spec 06, 07) ──────────────
//
// Everything the board's screens work out from a ScheduleBoard, pure and without React, so a test runs it
// (server/src/__tests__/client/p2-matching-board.test.ts): its words, who is who, the instant hint for a move (the one
// room checker, shared with the server, which stays the judge), conflicts, search and filters, the all-rounds rows and
// one person's meetings across the rounds.

import {
  checkRoom, formatEventTime, roundRuleSentence,
  type BoardOp, type BoardPerson, type BoardPersonStatus, type BoardRoom, type BoardRound, type RoomCheckContext, type RoomVerdict,
  type ScheduleBoard,
} from '@rsn/shared';

// ─── Words ───────────────────────────────────────────────────────────────────

export const BOARD_COPY = {
  basketTitle: 'UNASSIGNED BASKET',
  basketHint: 'Drag people here, swap occupied slots, then redistribute available participants.',
  redistribute: 'Redistribute',
  allRoundsTitle: 'ALL ROUNDS / MATCHING BOARD',
  autoGenerate: 'Auto generate',
  edit: 'Edit',
  lock: 'Lock',
  unlock: 'Unlock',
  publish: 'Publish',
  roundStarted: 'This round has started, so it can only be read now.',
  emptyRound: 'No meetings in this round yet. Auto generate fills every round with the matching rules.',
  nobodyYet: 'Nobody holds a place yet. People appear in the basket as they register.',
} as const;

export const MOVE_COPY = {
  swapWith: (name: string) => `Swap with ${name}`,
  moveTo: (room: number) => `Move to room ${room} (empty seat)`,
  toBasket: 'Move to the basket',
  lockMeeting: 'Lock this meeting',
  unlockMeeting: 'Unlock this meeting',
  lockSeat: (name: string) => `Keep ${name} in this seat`,
  unlockSeat: (name: string) => `Let ${name} move again`,
  showMeetings: (name: string) => `Show ${name}'s meetings`,
} as const;

const pad2 = (n: number) => String(n).padStart(2, '0');
export const roundTitle = (round: number) => `ROUND ${pad2(round)} / MATCHING BOARD`;
export const roomTitle = (room: number) => `Room ${pad2(room)}`;
export const waitingLine = (n: number) => `${n} ${n === 1 ? 'person' : 'people'} waiting`;

/**
 * When a round is expected to start, on the EVENT's clock with its zone named ("19:40 CET", Part 3 K1), or null. The
 * planner and every person on the board read the same time wherever they are.
 */
export function startsAtLabel(iso: string | null, zone: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return formatEventTime(at, zone, 'clock');
}

/** When a plan was published, on the viewer's own clock ("Wed 7:40 PM"): a moment of the board's history, not an event time. */
export function publishedAtLabel(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export const STATUS_LABEL: Record<BoardPersonStatus, string> = {
  registered: 'Registered',
  present: 'Here now',
  left: 'Left',
  no_show: 'No show',
  absent: 'Late or not coming',
  not_in_event: 'Not in the event',
};

/** A status worth showing beside a name (a registered person needs no note). */
export const statusNote = (status: BoardPersonStatus): string | null => (status === 'registered' ? null : STATUS_LABEL[status]);

function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ─── Who is who ──────────────────────────────────────────────────────────────

/** Everyone the board names: the event's people, then anyone seated or waiting who is not among them. */
export function peopleOf(board: ScheduleBoard): Map<string, BoardPerson> {
  const people = new Map<string, BoardPerson>();
  for (const p of board.people) people.set(p.userId, p);
  for (const round of board.rounds) {
    for (const room of round.rooms) for (const seat of room.seats) if (!people.has(seat.userId)) people.set(seat.userId, seat);
    for (const p of round.basket) if (!people.has(p.userId)) people.set(p.userId, p);
  }
  return people;
}

export const nameIn = (people: Map<string, BoardPerson>, userId: string) => people.get(userId)?.displayName ?? 'Someone';

/** The organiser's names of these groups ("Founders"), in the event's order; a key the event no longer has is left out. */
export function groupLabels(board: ScheduleBoard, keys: readonly string[]): string[] {
  return (board.groupRules?.groups ?? []).filter((g) => keys.includes(g.key)).map((g) => g.label);
}

export const roundOf = (board: ScheduleBoard, round: number): BoardRound | undefined =>
  board.rounds.find((r) => r.roundNumber === round);

/** The room a person sits in this round, or null (waiting, or not in the round). */
export function roomOfPerson(round: BoardRound | undefined, userId: string): BoardRoom | null {
  return round?.rooms.find((room) => room.seats.some((s) => s.userId === userId)) ?? null;
}

/** The number the next new room of a round takes. */
export const newRoomNumber = (round: BoardRound) => round.rooms.reduce((max, r) => Math.max(max, r.roomNumber), 0) + 1;

// ─── The instant hint: the shared room checker, before the server answers ───

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The checker's view of a round, from the board alone. Who blocked whom is not on the board, so blocks are left to the
 * server (it refuses such a room with the reason); groups, the round's rule and earlier meetings are all here.
 */
export function roomContextFor(board: ScheduleBoard, round: number): RoomCheckContext {
  const people = peopleOf(board);
  const met = new Set<string>();
  for (const r of board.rounds) {
    if (r.roundNumber >= round) continue;
    for (const room of r.rooms) {
      const ids = room.seats.map((s) => s.userId);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) met.add(pairKey(ids[i], ids[j]));
    }
  }
  return {
    round,
    rules: board.groupRules,
    groupsOf: (id) => people.get(id)?.groupKeys ?? [],
    hardExcluded: () => false,
    metBefore: (a, b) => met.has(pairKey(a, b)),
    maxRoomSize: 3,
  };
}

export type HintTone = 'ok' | 'warn' | 'bad';
export interface MoveHint { tone: HintTone; text: string }

const TONE_RANK: Record<HintTone, number> = { ok: 0, warn: 1, bad: 2 };
const worse = (a: MoveHint, b: MoveHint) => (TONE_RANK[b.tone] > TONE_RANK[a.tone] ? b : a);

/** One short line on what the checker thinks of a room. */
export function hintOf(verdict: RoomVerdict, nameOf: (id: string) => string): MoveHint {
  const problem = verdict.problems[0];
  if (problem) {
    switch (problem.kind) {
      case 'group_rule': return { tone: 'bad', text: "Breaks this round's group rule" };
      case 'no_group': return { tone: 'bad', text: `${andList(problem.userIds.map(nameOf))} ${problem.userIds.length === 1 ? 'has' : 'have'} no group yet` };
      case 'too_many': return { tone: 'bad', text: 'A meeting holds at most three people' };
      default: return { tone: 'bad', text: "These people can't meet" };
    }
  }
  const kinds = new Set(verdict.warnings.map((w) => w.kind));
  if (kinds.has('override')) return { tone: 'warn', text: 'Seated against the group rule' };
  if (kinds.has('repeat')) return { tone: 'warn', text: 'They have met before' };
  if (kinds.has('same_group_fallback')) return { tone: 'warn', text: 'Same group, allowed when groups are uneven' };
  if (kinds.has('vacancy')) return { tone: 'warn', text: 'Waits alone until someone joins' };
  return { tone: 'ok', text: 'Fits this round' };
}

const seatIds = (room: BoardRoom | null | undefined) => room?.seats.map((s) => s.userId) ?? [];

/** The hint for moving someone into a room of the round (an existing room, or a new number for an empty one). */
export function moveHint(board: ScheduleBoard, round: number, userId: string, toRoom: number): MoveHint {
  const r = roundOf(board, round);
  const target = r?.rooms.find((room) => room.roomNumber === toRoom);
  const members = [...seatIds(target).filter((id) => id !== userId), userId];
  const people = peopleOf(board);
  return hintOf(checkRoom(roomContextFor(board, round), members, { fallback: true }), (id) => nameIn(people, id));
}

/** The hint for a swap: the worse of the two rooms it makes (one, when the first person waits in the basket). */
export function swapHint(board: ScheduleBoard, round: number, userId: string, withUserId: string): MoveHint {
  const r = roundOf(board, round);
  const ctx = roomContextFor(board, round);
  const people = peopleOf(board);
  const nameOf = (id: string) => nameIn(people, id);
  const theirs = seatIds(roomOfPerson(r, withUserId)).map((id) => (id === withUserId ? userId : id));
  let hint = hintOf(checkRoom(ctx, theirs, { fallback: true }), nameOf);
  const mine = roomOfPerson(r, userId);
  if (mine) {
    const back = seatIds(mine).map((id) => (id === userId ? withUserId : id));
    hint = worse(hint, hintOf(checkRoom(ctx, back, { fallback: true }), nameOf));
  }
  return hint;
}

// ─── Verdicts and conflicts ──────────────────────────────────────────────────

export interface Badge { tone: 'problem' | 'warning'; label: string }

const PROBLEM_LABEL = { group_rule: 'Group rule', no_group: 'No group', too_many: 'Over three', hard_exclusion: "Can't meet" } as const;
const WARNING_LABEL = { repeat: 'Met before', same_group_fallback: 'Same group', override: 'Override', vacancy: 'Empty seat' } as const;

/** The badges a room card shows: problems first, then warnings, each once. */
export function verdictBadges(room: BoardRoom): Badge[] {
  const badges: Badge[] = [];
  const add = (badge: Badge) => { if (!badges.some((b) => b.label === badge.label)) badges.push(badge); };
  for (const p of room.verdict.problems) add({ tone: 'problem', label: PROBLEM_LABEL[p.kind] });
  for (const w of room.verdict.warnings) add({ tone: 'warning', label: WARNING_LABEL[w.kind] });
  return badges;
}

const UNSEATABLE: ReadonlySet<BoardPersonStatus> = new Set(['not_in_event', 'left', 'no_show', 'absent']);

/** Whether a room needs the organiser: the checker refuses it, a locked meeting lost someone, or someone can't be in it. */
export function roomHasConflict(room: BoardRoom): boolean {
  return !room.verdict.ok || (room.locked && room.seats.length < 2) || room.seats.some((s) => UNSEATABLE.has(s.status));
}

export interface BoardConflict { round: number; room: number | null; tone: 'problem' | 'warning'; text: string }

/** Everything to look at before publishing, round by round (one round when `onlyRound` is given): problems first. */
export function conflictsOf(board: ScheduleBoard, onlyRound?: number): BoardConflict[] {
  const people = peopleOf(board);
  const nameOf = (id: string) => nameIn(people, id);
  const out: BoardConflict[] = [];
  for (const r of board.rounds) {
    if (onlyRound !== undefined && r.roundNumber !== onlyRound) continue;
    const round = r.roundNumber;
    const rule = board.groupRules ? roundRuleSentence(board.groupRules, round) : '';
    for (const id of r.collisions) out.push({ round, room: null, tone: 'problem', text: `${nameOf(id)} is seated twice in round ${round}.` });
    for (const room of r.rooms) {
      const where = roomTitle(room.roomNumber);
      for (const p of room.verdict.problems) {
        const names = p.userIds.map(nameOf);
        const text = p.kind === 'too_many' ? `${where} holds more than three people.`
          : p.kind === 'hard_exclusion' ? `${names[0]} and ${names[1]} can't be in the same meeting.`
          : p.kind === 'no_group' ? `${andList(names)} ${names.length === 1 ? "isn't" : "aren't"} in a group yet, so they can't be matched in this round: ${rule}`
          : `${names[0]} and ${names[1]} can't meet in this round: ${rule}`;
        out.push({ round, room: room.roomNumber, tone: 'problem', text });
      }
      for (const seat of room.seats) {
        if (seat.status === 'not_in_event') out.push({ round, room: room.roomNumber, tone: 'problem', text: `${seat.displayName} isn't taking part any more. Move them out of ${where}.` });
        else if (seat.status === 'left') out.push({ round, room: room.roomNumber, tone: 'warning', text: `${seat.displayName} left the event.` });
        else if (seat.status === 'no_show') out.push({ round, room: room.roomNumber, tone: 'warning', text: `${seat.displayName} didn't come.` });
        else if (seat.status === 'absent') out.push({ round, room: room.roomNumber, tone: 'warning', text: `${seat.displayName} is marked late or not coming.` });
      }
      if (room.locked && room.seats.length < 2) {
        out.push({ round, room: room.roomNumber, tone: 'warning', text: `${where} is locked and has an empty seat. Nobody is moved into a locked meeting.` });
      }
      for (const w of room.verdict.warnings) {
        if (w.kind === 'repeat') out.push({ round, room: room.roomNumber, tone: 'warning', text: `${andList(w.userIds.map(nameOf))} have met before.` });
        if (w.kind === 'override') out.push({ round, room: room.roomNumber, tone: 'warning', text: `${where} breaks the group rule by an organiser's choice.` });
      }
    }
    if (r.capacity?.sentence) out.push({ round, room: null, tone: 'warning', text: r.capacity.sentence });
  }
  return out.sort((a, b) => Number(a.tone === 'warning') - Number(b.tone === 'warning'));
}

// ─── Search and filters ──────────────────────────────────────────────────────

export type StatusFilter = 'all' | 'waiting' | BoardPersonStatus;

export interface BoardFilter {
  query: string;
  group: string;
  status: StatusFilter;
  conflictsOnly: boolean;
  lockedOnly: boolean;
}

export const NO_FILTER: BoardFilter = { query: '', group: '', status: 'all', conflictsOnly: false, lockedOnly: false };

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'waiting', label: 'Waiting in the basket' },
  ...(Object.keys(STATUS_LABEL) as BoardPersonStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] })),
];

const personFiltered = (f: BoardFilter) => f.query.trim() !== '' || f.group !== '' || f.status !== 'all';
export const filterActive = (f: BoardFilter) => personFiltered(f) || f.conflictsOnly || f.lockedOnly;

/** Whether a person answers the search, the group and the status asked for. */
export function personMatches(person: BoardPerson, f: BoardFilter, waiting: boolean): boolean {
  const query = f.query.trim().toLowerCase();
  if (query && !person.displayName.toLowerCase().includes(query)) return false;
  if (f.group && !person.groupKeys.includes(f.group)) return false;
  if (f.status === 'waiting') return waiting;
  return f.status === 'all' || person.status === f.status;
}

/** Whether a room card stays on screen: its flags, and (when a person is searched for) someone in it who matches. */
export function roomMatches(room: BoardRoom, f: BoardFilter): boolean {
  if (f.conflictsOnly && !roomHasConflict(room)) return false;
  if (f.lockedOnly && !room.locked && !room.seats.some((s) => s.slotLocked)) return false;
  return !personFiltered(f) || room.seats.some((s) => personMatches(s, f, false));
}

/** Whether a seat is one the search picked out (to mark it), when a person is searched for at all. */
export const seatPicked = (person: BoardPerson, f: BoardFilter, waiting: boolean) => personFiltered(f) && personMatches(person, f, waiting);

// ─── All rounds ──────────────────────────────────────────────────────────────

export interface OverviewRow {
  key: string;
  round: number;
  startsAt: string | null;
  /** The room, or null for someone waiting in the basket. */
  room: number | null;
  roomLocked: boolean;
  slotLocked: boolean;
  userId: string;
  name: string;
  groups: string[];
  status: BoardPersonStatus;
  conflicts: string[];
}

/** One row per seat and per person waiting, round by round, room by room. */
export function overviewRows(board: ScheduleBoard): OverviewRow[] {
  const rows: OverviewRow[] = [];
  for (const r of board.rounds) {
    for (const room of r.rooms) {
      for (const seat of room.seats) {
        const conflicts = [
          ...room.verdict.problems.filter((p) => p.userIds.includes(seat.userId)).map((p) => PROBLEM_LABEL[p.kind]),
          ...room.verdict.warnings.filter((w) => w.kind !== 'vacancy' && w.userIds.includes(seat.userId)).map((w) => WARNING_LABEL[w.kind]),
          ...(r.collisions.includes(seat.userId) ? ['Seated twice'] : []),
          ...(UNSEATABLE.has(seat.status) ? [STATUS_LABEL[seat.status]] : []),
          ...(room.locked && room.seats.length < 2 ? ['Locked, empty seat'] : []),
        ];
        rows.push({
          key: `${r.roundNumber}:${room.roomNumber}:${seat.userId}`, round: r.roundNumber, startsAt: r.startsAt, room: room.roomNumber,
          roomLocked: room.locked, slotLocked: seat.slotLocked, userId: seat.userId, name: seat.displayName,
          groups: groupLabels(board, seat.groupKeys), status: seat.status, conflicts: [...new Set(conflicts)],
        });
      }
    }
    for (const p of r.basket) {
      rows.push({
        key: `${r.roundNumber}:basket:${p.userId}`, round: r.roundNumber, startsAt: r.startsAt, room: null, roomLocked: false,
        slotLocked: false, userId: p.userId, name: p.displayName, groups: groupLabels(board, p.groupKeys), status: p.status, conflicts: [],
      });
    }
  }
  return rows;
}

export function rowMatches(row: OverviewRow, person: BoardPerson | undefined, f: BoardFilter): boolean {
  if (f.conflictsOnly && row.conflicts.length === 0) return false;
  if (f.lockedOnly && !row.roomLocked && !row.slotLocked) return false;
  const subject: BoardPerson = person ?? { userId: row.userId, displayName: row.name, avatarUrl: null, groupKeys: [], status: row.status };
  return personMatches({ ...subject, displayName: row.name, status: row.status }, f, row.room === null);
}

// ─── One person across the rounds (spec 07: "review all assignments for that attendee") ───

export interface TimelineEntry {
  round: number;
  startsAt: string | null;
  editable: boolean;
  /** Where they are: a room, the basket, or neither (marked late or not coming for this round). */
  place: { kind: 'room'; room: number; locked: boolean; partners: string[] } | { kind: 'basket' } | { kind: 'away' };
}

export function timelineOf(board: ScheduleBoard, userId: string): TimelineEntry[] {
  return board.rounds.filter((r) => !r.beyondLastRound).map((r) => {
    const room = roomOfPerson(r, userId);
    const base = { round: r.roundNumber, startsAt: r.startsAt, editable: r.editable };
    if (room) {
      const partners = room.seats.filter((s) => s.userId !== userId).map((s) => {
        const labels = groupLabels(board, s.groupKeys);
        return labels.length ? `${s.displayName} (${labels.join(', ')})` : s.displayName;
      });
      return { ...base, place: { kind: 'room', room: room.roomNumber, locked: room.locked, partners } };
    }
    if (r.basket.some((p) => p.userId === userId)) return { ...base, place: { kind: 'basket' } };
    return { ...base, place: { kind: 'away' } };
  });
}

/** One line for a round of someone's timeline. */
export function timelineLine(entry: TimelineEntry): string {
  if (entry.place.kind === 'basket') return 'Waiting in the basket';
  if (entry.place.kind === 'away') return 'Marked late or not coming';
  const who = entry.place.partners.length ? `with ${andList(entry.place.partners)}` : 'alone so far';
  return `${roomTitle(entry.place.room)}, ${who}${entry.place.locked ? ' (locked)' : ''}`;
}

// ─── What a change did, said aloud (fix round 1: the board's live region) ───

/** Where someone is in a round now: "Ann is in Room 03 now." or "Ann is waiting in the basket. 3 people waiting." */
export function placeLine(board: ScheduleBoard, round: number, userId: string): string {
  const name = nameIn(peopleOf(board), userId);
  const r = roundOf(board, round);
  const room = roomOfPerson(r, userId);
  if (room) return `${name} is in ${roomTitle(room.roomNumber)} now.`;
  if (r?.basket.some((p) => p.userId === userId)) return `${name} is waiting in the basket. ${waitingLine(r.basket.length)}.`;
  return `${name} has no seat in round ${round}.`;
}

/** The person a change is about, if it is about one. */
export const personOfOp = (op: BoardOp): string | null => ('userId' in op ? op.userId : null);

/** The sentence for a change the server made, read from the board it answered with; null when the caller says it. */
export function outcomeSentence(board: ScheduleBoard, op: BoardOp): string | null {
  switch (op.kind) {
    case 'move':
    case 'unassign': return placeLine(board, op.round, op.userId);
    case 'swap': return `${placeLine(board, op.round, op.userId)} ${placeLine(board, op.round, op.withUserId)}`;
    case 'lock_room': return `${roomTitle(op.room)} is locked.`;
    case 'unlock_room': return `${roomTitle(op.room)} is unlocked.`;
    case 'lock_slot': return `${nameIn(peopleOf(board), op.userId)} keeps this seat.`;
    case 'unlock_slot': return `${nameIn(peopleOf(board), op.userId)} can move again.`;
    case 'redistribute': {
      const rounds = op.rounds === 'all' ? board.rounds : board.rounds.filter((r) => (op.rounds as number[]).includes(r.roundNumber));
      return rounds.length === 1 ? `Round ${rounds[0].roundNumber}: ${waitingLine(rounds[0].basket.length)}.` : null;
    }
    default: return null;
  }
}

/** The sentence for a change the server refused (the reason itself is in the error toast or the refusal sheet). */
export function stayedSentence(board: ScheduleBoard, op: BoardOp): string {
  const who = personOfOp(op);
  if (who) return `Nothing changed: ${nameIn(peopleOf(board), who)} stayed where they were.`;
  if (op.kind === 'lock_room' || op.kind === 'unlock_room') return `Nothing changed in ${roomTitle(op.room)}.`;
  return 'Nothing changed on the board.';
}
