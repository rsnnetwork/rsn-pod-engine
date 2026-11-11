// ─── Seating a round's basket (10 Nov 2026 spec, Part 2 Task 8; section 07 "locks across regeneration", 12/08) ──
//
// One round of the matching board: some people are seated (some rooms or seats locked), the rest wait in the
// basket. This seats the basket without touching anything locked and without moving anyone already seated:
//   1. a locked room is never read or written; a locked seat keeps its person where they are;
//   2. each unlocked room holding one person gets the basket person the room checker allows, preferring a
//      rule-abiding pair over the organiser's same-group fallback, then someone they have not met, then whoever
//      has had the fewest meetings, then (Part 3 Task 5, an event with matching questions) whose answers suit best,
//      then registration order;
//   3. the rest of the basket is paired by the engine (`generate`: Task 7's generateGroupedRound, which applies
//      the round's rule and the organiser's fallback) into new rooms numbered after the highest in use;
//   4. anyone still waiting joins an unlocked pair as a trio only when the checker allows the three, else waits,
//      with the reason: nobody they may meet, only people they already met, or the round's group rule.
// Every room this writes is one the checker passes. Pure: no database, no clock.

import { checkRoom, type RoomCheckContext, type RoomVerdict, type RoundAssignment } from '@rsn/shared';

export type WaitingReason = 'no_allowed_partner' | 'only_repeats' | 'group_rule';

export interface RedistributeInput {
  round: number;
  /** Room number → the people in it. Not changed: the result is a new map. */
  seated: Map<number, string[]>;
  lockedRooms: Set<number>;
  /** People whose seat in this round is locked. */
  lockedSlots: Set<string>;
  /** The round's basket, in registration order. */
  basket: string[];
  ctx: RoomCheckContext;
  generate: (people: string[]) => RoundAssignment;
  /** Meetings each person already has in the event (fewer is preferred when filling a seat); none known = 0. */
  meetingsOf?: (userId: string) => number;
  /**
   * Part 3 Task 5 (K5) — how well two people's answers to the event's matching questions suit each other (0..1). Only an
   * event with questions passes it; it orders the candidates the checker already allows, after fairness, never before.
   */
  affinity?: (a: string, b: string) => number;
}

export interface RedistributeResult {
  seated: Map<number, string[]>;
  placed: string[];
  waiting: Array<{ userId: string; reason: WaitingReason }>;
}

const GROUP_PROBLEMS = new Set(['group_rule', 'no_group']);

/** The checker's verdict on a room, allowing the organiser's same-group fallback where the event chose it. */
function verdictOf(ctx: RoomCheckContext, members: string[]): RoomVerdict {
  return checkRoom(ctx, members, { fallback: true });
}

const involves = (userIds: string[], id: string) => userIds.includes(id);
const hasWarning = (v: RoomVerdict, kind: string, id: string) => v.warnings.some((w) => w.kind === kind && involves(w.userIds, id));

/** Lower is better: a rule-abiding seat, then a first meeting. */
function seatCost(v: RoomVerdict, id: string): [number, number] {
  return [hasWarning(v, 'same_group_fallback', id) ? 1 : 0, hasWarning(v, 'repeat', id) ? 1 : 0];
}

function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function roomMembersOf(pair: { participantAId: string; participantBId: string; participantCId?: string | null }): string[] {
  return [pair.participantAId, pair.participantBId, pair.participantCId].filter((x): x is string => !!x);
}

/** Why someone left waiting could not be seated with anyone the round still has room for. */
function waitingReason(ctx: RoomCheckContext, id: string, candidates: string[][]): WaitingReason {
  const verdicts = candidates.map((room) => verdictOf(ctx, [...room, id]));
  const passing = verdicts.filter((v) => v.ok);
  if (passing.length > 0) {
    return passing.every((v) => hasWarning(v, 'repeat', id)) ? 'only_repeats' : 'no_allowed_partner';
  }
  const refusedByRule = verdicts.length > 0 && verdicts.every((v) =>
    v.problems.some((p) => GROUP_PROBLEMS.has(p.kind) && involves(p.userIds, id)));
  return refusedByRule ? 'group_rule' : 'no_allowed_partner';
}

/**
 * Seat the basket. Part 3 Task 5 (K5, fix round 1): an event's matching questions (`affinity`) only order the candidates,
 * and step 2 fills rooms one at a time, so a preference alone could leave a later room with nobody it may take. With
 * `affinity` the basket is therefore seated twice, with and without it, and the result with it is kept only when it
 * seats at least as many people with no more same-group fallbacks and no more repeats. Without `affinity` it is seated
 * once, exactly as before.
 */
export function redistributeRound(input: RedistributeInput): RedistributeResult {
  const result = seatOnce(input);
  if (!input.affinity) return result;
  const plain = seatOnce({ ...input, affinity: undefined });
  return affinityNoWorse(input.ctx, result, plain) ? result : plain;
}

/** Same-group fallbacks and repeats among the rooms a result holds (each warning counted per person it names). */
function costsOf(ctx: RoomCheckContext, result: RedistributeResult): { fallback: number; repeat: number } {
  let fallback = 0;
  let repeat = 0;
  for (const members of result.seated.values()) {
    if (members.length < 2) continue;
    for (const w of verdictOf(ctx, members).warnings) {
      if (w.kind === 'same_group_fallback') fallback += w.userIds.length;
      if (w.kind === 'repeat') repeat += w.userIds.length;
    }
  }
  return { fallback, repeat };
}

function affinityNoWorse(ctx: RoomCheckContext, withAffinity: RedistributeResult, without: RedistributeResult): boolean {
  if (withAffinity.placed.length < without.placed.length) return false;
  const a = costsOf(ctx, withAffinity);
  const b = costsOf(ctx, without);
  return a.fallback <= b.fallback && a.repeat <= b.repeat;
}

function seatOnce(input: RedistributeInput): RedistributeResult {
  const { ctx, lockedRooms } = input;
  const seated = new Map<number, string[]>([...input.seated].map(([room, members]) => [room, [...members]]));
  const occupied = new Set([...seated.values()].flat());
  const order = new Map<string, number>();
  for (const id of input.basket) if (!occupied.has(id) && !order.has(id)) order.set(id, order.size);
  const meetings = input.meetingsOf ?? (() => 0);
  const waitingSet = new Set(order.keys());
  const placed: string[] = [];
  const seat = (room: number, id: string) => {
    seated.get(room)!.push(id);
    waitingSet.delete(id);
    placed.push(id);
  };
  const openRooms = () => [...seated.keys()].filter((room) => !lockedRooms.has(room)).sort((a, b) => a - b);

  // 2. Rooms holding one person.
  for (const room of openRooms()) {
    const members = seated.get(room)!;
    if (members.length !== 1) continue;
    let best: { id: string; cost: number[] } | null = null;
    for (const id of waitingSet) {
      const v = verdictOf(ctx, [...members, id]);
      if (!v.ok) continue;
      const cost = input.affinity
        ? [...seatCost(v, id), meetings(id), -input.affinity(members[0], id), order.get(id)!]
        : [...seatCost(v, id), meetings(id), order.get(id)!];
      if (!best || lessThan(cost, best.cost)) best = { id, cost };
    }
    if (best) seat(room, best.id);
  }

  // 3. The engine pairs the rest into new rooms.
  if (waitingSet.size >= 2) {
    const people = [...waitingSet];
    const assignment = input.generate(people);
    let nextRoom = Math.max(0, ...seated.keys());
    for (const pair of assignment.pairs) {
      const members = roomMembersOf(pair);
      if (!members.every((id) => waitingSet.has(id))) continue;
      if (!verdictOf(ctx, members).ok) continue;
      nextRoom += 1;
      seated.set(nextRoom, []);
      for (const id of members) seat(nextRoom, id);
    }
  }

  // 4. Whoever is left joins an unlocked pair as a trio, when the checker allows the three.
  for (const id of [...waitingSet]) {
    let best: { room: number; cost: number[] } | null = null;
    for (const room of openRooms()) {
      const members = seated.get(room)!;
      if (members.length !== 2) continue;
      const v = verdictOf(ctx, [...members, id]);
      if (!v.ok) continue;
      const cost = [...seatCost(v, id), room];
      if (!best || lessThan(cost, best.cost)) best = { room, cost };
    }
    if (best) seat(best.room, id);
  }

  const waiting = [...waitingSet].map((id) => {
    const candidates = [
      ...openRooms().map((room) => seated.get(room)!).filter((m) => m.length > 0 && m.length < ctx.maxRoomSize),
      ...[...waitingSet].filter((other) => other !== id).map((other) => [other]),
    ];
    return { userId: id, reason: waitingReason(ctx, id, candidates) };
  });
  return { seated, placed, waiting };
}
