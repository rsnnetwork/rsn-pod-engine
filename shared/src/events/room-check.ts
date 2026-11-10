// ─── The one room checker (10 Nov 2026 spec, sections 05 and 07) ──────────────────────────────────────────
//
// Whether a room of a round may stand. The engine, the matching board, live swaps and redistribution, and the
// organiser's instant hint before the server answers all ask this one function, so they never disagree.
// Every pair in the room is checked. Problems refuse the room; warnings let it stand and say why it is unusual.
// An event with no groups (rules === null) skips every group check: such an event only ever meets the hard
// exclusions (blocks, reports, an inviter and their invitee) and the size, exactly as before groups existed.

import { groupsAllowed, ruleForRound, type EventGroupRules } from './group-rules';

export interface RoomCheckContext {
  round: number;
  /** The event's groups and round rules, or null for an event with no groups (the inert path). */
  rules: EventGroupRules | null;
  /** This person's groups in this event (never read from their account). A key not among `rules.groups` reads as no group. */
  groupsOf(userId: string): readonly string[];
  /** These two must never meet: one blocked or reported the other, or one invited the other. */
  hardExcluded(a: string, b: string): boolean;
  /** These two already met in an earlier round of this event. */
  metBefore(a: string, b: string): boolean;
  maxRoomSize: 3;
}

export type RoomProblem = { kind: 'hard_exclusion' | 'group_rule' | 'no_group' | 'too_many'; userIds: string[] };
export type RoomWarning = { kind: 'repeat' | 'vacancy' | 'same_group_fallback' | 'override'; userIds: string[] };

export interface RoomVerdict {
  ok: boolean;
  problems: RoomProblem[];
  warnings: RoomWarning[];
}

export interface RoomCheckOptions {
  /** An organiser chose to break the group rule for this room: group problems become an override warning. */
  override?: boolean;
  /** Same-group pairs are allowed here because the event lets people a rule leaves out meet their own group. */
  fallback?: boolean;
}

const sharesGroup = (a: readonly string[], b: readonly string[]) => a.some((g) => b.includes(g));

/** Every pair in the room, in seat order. */
function pairsOf(memberIds: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) pairs.push([memberIds[i], memberIds[j]]);
  }
  return pairs;
}

/**
 * The verdict on one room. `override` turns a group_rule or no_group problem into an `override` warning (never a
 * hard exclusion, never a room over three). `fallback` lets a same-group pair meet, with a warning, only when the
 * event's rules say so (`fallback: 'same_group_meeting'`).
 */
export function checkRoom(ctx: RoomCheckContext, memberIds: readonly string[], opts: RoomCheckOptions = {}): RoomVerdict {
  const problems: RoomProblem[] = [];
  const warnings: RoomWarning[] = [];
  if (memberIds.length > ctx.maxRoomSize) problems.push({ kind: 'too_many', userIds: [...memberIds] });
  if (memberIds.length < 2) warnings.push({ kind: 'vacancy', userIds: [...memberIds] });

  const rule = ctx.rules ? ruleForRound(ctx.rules, ctx.round) : null;
  const restricted = rule !== null && rule.mode !== 'open';
  const sameGroupAllowed = !!opts.fallback && ctx.rules?.fallback === 'same_group_meeting';
  const groupless = new Set<string>();
  // Only the event's own groups count: a key the rules no longer have (a stale board or screen after a save) is
  // read as no group, so the checker, the capacity count and the engine treat that person alike.
  const known = new Set(ctx.rules?.groups.map((g) => g.key) ?? []);
  const groupsOf = (id: string) => ctx.groupsOf(id).filter((g) => known.has(g));

  for (const [a, b] of pairsOf(memberIds)) {
    if (ctx.hardExcluded(a, b)) problems.push({ kind: 'hard_exclusion', userIds: [a, b] });
    if (restricted) {
      const ga = groupsOf(a);
      const gb = groupsOf(b);
      if (ga.length === 0 || gb.length === 0) {
        if (ga.length === 0) groupless.add(a);
        if (gb.length === 0) groupless.add(b);
      } else if (!groupsAllowed(rule, ga, gb)) {
        if (sameGroupAllowed && sharesGroup(ga, gb)) warnings.push({ kind: 'same_group_fallback', userIds: [a, b] });
        else if (opts.override) warnings.push({ kind: 'override', userIds: [a, b] });
        else problems.push({ kind: 'group_rule', userIds: [a, b] });
      }
    }
    if (ctx.metBefore(a, b)) warnings.push({ kind: 'repeat', userIds: [a, b] });
  }
  if (groupless.size > 0) {
    const userIds = memberIds.filter((id) => groupless.has(id));
    if (opts.override) warnings.push({ kind: 'override', userIds });
    else problems.push({ kind: 'no_group', userIds });
  }
  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Every room of a round, and anyone seated twice (in two rooms, or twice in one), in the order they were first
 * seen twice.
 */
export function checkRound(
  ctx: RoomCheckContext,
  rooms: ReadonlyArray<{ roomNumber: number; memberIds: string[]; override?: boolean; fallback?: boolean }>,
): { collisions: string[]; verdicts: Map<number, RoomVerdict> } {
  const seen = new Set<string>();
  const collisions: string[] = [];
  const verdicts = new Map<number, RoomVerdict>();
  for (const room of rooms) {
    for (const id of room.memberIds) {
      if (seen.has(id) && !collisions.includes(id)) collisions.push(id);
      seen.add(id);
    }
    verdicts.set(room.roomNumber, checkRoom(ctx, room.memberIds, { override: room.override, fallback: room.fallback }));
  }
  return { collisions, verdicts };
}
