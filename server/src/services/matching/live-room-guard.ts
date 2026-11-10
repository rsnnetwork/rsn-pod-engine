// ─── Rooms a host makes by hand, live, held to the engine's rules (Part 2 Task 7; spec 05, 07, 13) ─────────
//
// The host's swap, exclude, move-to-room, reassign, breakout, bulk breakout and add-to-room each produce rooms the
// engine did not make. Each asks the one room checker (shared/src/events/room-check.ts) about every room it is about
// to write, before writing it:
//   - two people one of whom blocked (or reported) the other are always refused, on every event, override or not;
//   - on an event with groups, a room this round's rule does not allow is refused with the rule in the organiser's
//     words, unless the request carries `override: true` and the actor is the event's owner (host_user_id) or a
//     super admin; then it goes ahead and one `match.override` audit row records it, with the reason given.
// An event without groups checks the blocks only: a host may still seat an inviter with their guest, or two people
// who met before, exactly as before.

import { z } from 'zod';
import {
  checkRoom, ErrorCodes, roundRuleSentence, UserRole, type RoomCheckContext, type RoomProblem,
} from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { pairKey } from './matching.interface';
import { loadHardExclusions } from './hard-exclusions';
import { getEventGroupRules, groupsForParticipants } from '../session/event-groups.service';

export const BLOCKED_PAIR_MESSAGE = "These two people can't meet: one has blocked the other.";
export const OVERRIDE_FORBIDDEN_MESSAGE = 'Only the event owner or a super admin can override group rules.';
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

/** The event's owner or a super admin, read from the database (never from the token). */
async function mayOverrideGroupRules(sessionId: string, actorId: string): Promise<boolean> {
  const result = await query<{ host_user_id: string | null; role: string | null }>(
    `SELECT s.host_user_id, (SELECT u.role FROM users u WHERE u.id = $2) AS role FROM sessions s WHERE s.id = $1`,
    [sessionId, actorId],
  );
  const row = result.rows[0];
  return !!row && (row.host_user_id === actorId || row.role === UserRole.SUPER_ADMIN);
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
  if (!(await mayOverrideGroupRules(input.sessionId, input.actorId))) {
    return { ok: false, code: ErrorCodes.GROUP_OVERRIDE_FORBIDDEN, message: OVERRIDE_FORBIDDEN_MESSAGE };
  }
  return {
    ok: true,
    overridden: broken.map((v) => ({ memberIds: v.memberIds, problems: v.verdict.problems })),
    reason: parsed.data.reason || null,
  };
}

/**
 * One `match.override` audit row for rooms written against the round's group rule, in the event audit shape
 * (entity_type 'session'; details { automatic, scheduleVersion, round, subjectUserIds, before, after, reason }).
 * Called after the write succeeded; a failed audit write is logged and never fails the host's live action.
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
  const details = {
    automatic: false,
    scheduleVersion: null,
    round: entry.round,
    subjectUserIds: [...new Set(entry.overridden.flatMap((o) => o.memberIds))],
    before: null,
    after: { via: entry.via, rooms: entry.overridden },
    reason: entry.reason,
  };
  try {
    await query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, 'match.override', 'session', $2, $3)`,
      [entry.actorId, entry.sessionId, JSON.stringify(details)],
    );
  } catch (err) {
    logger.warn({ err, sessionId: entry.sessionId }, 'match.override audit write failed (the host action stands)');
  }
}
