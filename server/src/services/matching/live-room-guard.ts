// ─── Rooms a host makes by hand, live, held to the engine's rules (Part 2 Task 7; spec 05, 07, 13) ─────────
//
// The host's swap, exclude, move-to-room, reassign, breakout, bulk breakout and add-to-room each produce rooms the
// engine did not make. Each asks the one room checker (shared/src/events/room-check.ts) about every room it is about
// to write, before writing it:
//   - two people one of whom blocked (or reported) the other are always refused, on every event, override or not;
//   - on an event with groups, a room this round's rule does not allow is refused with the rule in the organiser's
//     words, unless the request carries `override: true` and the actor may override (mayOverrideGroupRules: the
//     event's owner, host_user_id, or a super admin; and its co-hosts when the owner chose so, Part 3 Task 12); then
//     it goes ahead and one `match.override` audit row records it, with the reason given.
// An event without groups checks the blocks only: a host may still seat an inviter with their guest, or two people
// who met before, exactly as before.

import { z } from 'zod';
import {
  checkRoom, ErrorCodes, roundRuleSentence, UserRole, type GroupOverrideBy, type RoomCheckContext, type RoomProblem,
} from '@rsn/shared';
import { query } from '../../db';
import { recordEventAudit } from '../audit/event-audit';
import { pairKey } from './matching.interface';
import { loadHardExclusions } from './hard-exclusions';
import { getEventGroupRules, groupsForParticipants } from '../session/event-groups.service';

export const BLOCKED_PAIR_MESSAGE = "These two people can't meet: one has blocked the other.";
/**
 * The refusal says who may override as the owner chose it (Part 3 Task 12 ruling): the owner alone, or the owner and
 * the event's co-hosts. Super admins may always override but are not named to users.
 */
export const OWNER_ONLY_OVERRIDE_MESSAGE = "Only the event's owner can override group rules.";
export const OWNER_AND_COHOSTS_OVERRIDE_MESSAGE = "Only the event's owner and co-hosts can override group rules.";

export function overrideForbiddenMessage(overrideBy: GroupOverrideBy): string {
  return overrideBy === 'owner_and_cohosts' ? OWNER_AND_COHOSTS_OVERRIDE_MESSAGE : OWNER_ONLY_OVERRIDE_MESSAGE;
}
const TOO_MANY_MESSAGE = 'A room holds at most three people.';
const UNREADABLE_MESSAGE = "That request couldn't be read. Please try again.";

/** The override part of a host's request; the rest of the payload is the handler's own. */
const overrideRequestSchema = z.object({
  override: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
}).passthrough();

export interface OverriddenRoom {
  memberIds: string[];
  problems: RoomProblem[];
}

export type LiveRoomsVerdict =
  | { ok: true; overridden: OverriddenRoom[]; reason: string | null }
  | { ok: false; code: string; message: string };

/**
 * The checker's context for rooms a host makes live in `round`: the event's groups (null without groups), and the
 * blocks and reports among these people, read through the engine's own loader. History and invites are not
 * refused by hand (metBefore and the invite pairs are left out), as before.
 */
export async function loadLiveRoomContext(sessionId: string, round: number, people: string[]): Promise<RoomCheckContext> {
  const rules = await getEventGroupRules(sessionId);
  const { blocked } = await loadHardExclusions(sessionId, people);
  const blockedKeys = new Set(blocked.map((token) => {
    const [a, b] = token.split(':');
    return pairKey(a, b);
  }));
  const groups = rules ? await groupsForParticipants(sessionId) : new Map<string, string[]>();
  return {
    round,
    rules,
    groupsOf: (userId) => groups.get(userId) ?? [],
    hardExcluded: (a, b) => blockedKeys.has(pairKey(a, b)),
    metBefore: () => false,
    maxRoomSize: 3,
  };
}

async function namesOf(userIds: string[]): Promise<Map<string, string>> {
  const result = await query<{ id: string; display_name: string | null }>(
    `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [userIds],
  );
  return new Map(result.rows.map((r) => [r.id, (r.display_name ?? '').trim() || 'Someone']));
}

function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The organiser's sentence for the first group problem: who, and what this round's rule allows. */
async function groupProblemMessage(ctx: RoomCheckContext, problem: RoomProblem): Promise<string> {
  const names = await namesOf(problem.userIds);
  const who = problem.userIds.map((id) => names.get(id) ?? 'Someone');
  const rule = ctx.rules ? roundRuleSentence(ctx.rules, ctx.round) : '';
  if (problem.kind === 'no_group') {
    return `${andList(who)} ${who.length === 1 ? "isn't" : "aren't"} in a group yet, so they can't be matched in this round: ${rule}`;
  }
  return `${who[0]} and ${who[1]} can't meet in this round: ${rule}`;
}

/** Whether this person may override the event's group rules, and the owner's choice (for the refusal's sentence). */
export interface GroupOverrideStanding {
  allowed: boolean;
  overrideBy: GroupOverrideBy;
}

/**
 * Who may override this event's group rules, read from the database on every call (never from the token): the event's
 * owner (host_user_id) or a super admin, always; and, when the owner chose 'owner_and_cohosts'
 * (event_matching_rules.override_by, Part 3 Task 12), the event's co-hosts. No choice (no row) is 'owner'.
 * A co-host here is a session_cohosts row with role 'co_host' only: a moderator (role 'moderator') never gains the
 * override, whatever the owner chose (Part 3 Task 12 ruling). Nor does a pod director who is not a co-host of the
 * event, or a platform admin.
 */
export async function groupOverrideStanding(sessionId: string, actorId: string): Promise<GroupOverrideStanding> {
  const result = await query<{ host_user_id: string | null; role: string | null; override_by: string | null; is_cohost: boolean | null }>(
    `SELECT s.host_user_id, (SELECT u.role FROM users u WHERE u.id = $2) AS role,
            (SELECT r.override_by FROM event_matching_rules r WHERE r.session_id = s.id) AS override_by,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2 AND c.role = 'co_host') AS is_cohost
       FROM sessions s WHERE s.id = $1`,
    [sessionId, actorId],
  );
  const row = result.rows[0];
  if (!row) return { allowed: false, overrideBy: 'owner' };
  const overrideBy: GroupOverrideBy = row.override_by === 'owner_and_cohosts' ? 'owner_and_cohosts' : 'owner';
  if (row.host_user_id === actorId || row.role === UserRole.SUPER_ADMIN) return { allowed: true, overrideBy };
  return { allowed: overrideBy === 'owner_and_cohosts' && row.is_cohost === true, overrideBy };
}

/** groupOverrideStanding, yes or no: the matching board's canOverride. */
export async function mayOverrideGroupRules(sessionId: string, actorId: string): Promise<boolean> {
  return (await groupOverrideStanding(sessionId, actorId)).allowed;
}

/**
 * Whether the rooms a host is about to write in `round` may stand. Rooms of one break no rule. A block refuses
 * everything; a group problem refuses unless overridden by someone who may. Nothing is written here.
 */
export async function judgeLiveRooms(input: {
  sessionId: string;
  round: number;
  rooms: string[][];
  actorId: string;
  /** The handler's payload: its optional `override` and `reason` are read here. */
  request: unknown;
}): Promise<LiveRoomsVerdict> {
  const parsed = overrideRequestSchema.safeParse(input.request ?? {});
  if (!parsed.success) return { ok: false, code: ErrorCodes.VALIDATION_ERROR, message: UNREADABLE_MESSAGE };
  const rooms = input.rooms.filter((r) => r.length >= 2);
  if (rooms.length === 0) return { ok: true, overridden: [], reason: null };

  const ctx = await loadLiveRoomContext(input.sessionId, input.round, [...new Set(rooms.flat())]);
  const verdicts = rooms.map((memberIds) => ({ memberIds, verdict: checkRoom(ctx, memberIds, { fallback: true }) }));
  const problems = verdicts.flatMap((v) => v.verdict.problems);
  if (problems.some((p) => p.kind === 'hard_exclusion')) {
    return { ok: false, code: ErrorCodes.MATCH_BLOCKED_PAIR, message: BLOCKED_PAIR_MESSAGE };
  }
  if (problems.some((p) => p.kind === 'too_many')) {
    return { ok: false, code: ErrorCodes.VALIDATION_ERROR, message: TOO_MANY_MESSAGE };
  }
  const broken = verdicts.filter((v) => v.verdict.problems.length > 0);
  if (broken.length === 0) return { ok: true, overridden: [], reason: null };
  if (parsed.data.override !== true) {
    return { ok: false, code: ErrorCodes.MATCH_GROUP_RULE, message: await groupProblemMessage(ctx, broken[0].verdict.problems[0]) };
  }
  const standing = await groupOverrideStanding(input.sessionId, input.actorId);
  if (!standing.allowed) {
    return { ok: false, code: ErrorCodes.GROUP_OVERRIDE_FORBIDDEN, message: overrideForbiddenMessage(standing.overrideBy) };
  }
  return {
    ok: true,
    overridden: broken.map((v) => ({ memberIds: v.memberIds, problems: v.verdict.problems })),
    reason: parsed.data.reason || null,
  };
}

/**
 * One `match.override` row in the event's audit trail (recordEventAudit, Part 2 Task 1) for rooms written against
 * the round's group rule. Called after the write succeeded, without a transaction: best-effort by design, so a
 * failed audit write is logged and never fails the host's live action, and the organisers' history is told at once.
 */
export async function recordMatchOverride(entry: {
  sessionId: string;
  actorId: string;
  round: number;
  via: 'swap' | 'exclude' | 'move_to_room' | 'breakout' | 'breakout_bulk' | 'add_to_room';
  overridden: OverriddenRoom[];
  reason: string | null;
}): Promise<void> {
  if (entry.overridden.length === 0) return;
  await recordEventAudit({
    sessionId: entry.sessionId,
    actorId: entry.actorId,
    action: 'match.override',
    automatic: false,
    round: entry.round,
    subjectUserIds: [...new Set(entry.overridden.flatMap((o) => o.memberIds))],
    before: null,
    after: { via: entry.via, rooms: entry.overridden },
    ...(entry.reason ? { reason: entry.reason } : {}),
  });
}
