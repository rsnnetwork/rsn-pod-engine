// ─── Publishing the matching board (10 Nov 2026 spec, Part 2 Task 9; sections 06, 07, 12/10) ────────────────
//
// The organisers' draft (schedule-board.service.ts) is private. Publishing freezes it into a numbered version
// (event_schedule_versions, migration 141) that is never edited again, and the live event follows the latest version
// (schedule-live.service.ts): Key decision D4, one schedule pipeline.
//
//   previewPublish     what publishing now would do: what blocks it, what it keeps, who it changes meetings for.
//   publishSchedule    refuse with the list while anything blocks (409 SCHEDULE_HAS_CONFLICTS); else write version
//                      N+1 in the transaction that holds the board's row (so no edit lands between the check and the
//                      write), audit it with its version, tell the screens, ring the impacted, and while the event is
//                      live rewrite the changed rooms of the rounds not yet started.
//   publishLocked      the write itself, inside a caller's locked draft: the live repairs publish their automatic
//                      versions through it, in the same transaction as their draft edit.
//   getMySchedule      a participant's own meetings in the latest version (never the draft); null before the first.
//   listScheduleVersions  the organisers' list of versions.
//
// Who is told: every version tells the organisers' boards (session:<id>:schedule) and everyone in the event
// (session:<id>:published-schedule). The first version published before the event tells nobody more (it is the
// plan, not a change). A later version, or any version while the event is live, rings a bell for each person whose
// meetings changed in a round not yet started, and only them: "Your meetings for {title} changed". Email waits for
// the owner's change-notice deadline (Deferred).

import {
  ErrorCodes, estimatedRoundStarts, UserRole,
  type MySchedule, type PublishPreview, type PublishPreviewItem, type PublishResult, type ScheduleSnapshot,
  type ScheduleVersionSummary,
} from '@rsn/shared';
import logger from '../../config/logger';
import { query } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { fanoutPublishedSchedule, fanoutScheduleDraft } from '../../realtime/fanout';
import { emitEventAuditChanged, recordEventAudit } from '../audit/event-audit';
import { canActAsHost } from '../roles/effective-role.service';
import type { Actor } from '../roles/actor';
import { getEventGroupRules, groupsForParticipants } from '../session/event-groups.service';
import { eventPagePath, ringEventBells } from '../session/event-notices';
import { isLiveStatus } from '../session/main-room';
import { FORMER_MEMBER_NAME } from '../users/active-member';
import {
  ENDED, STALE, andList, buildRound, isEditable, isEnded, loadState, nameOf, prepareWrite, problemMessage, readBoard,
  requireOrganiser, sameSnapshot, snapshotOf, withLockedDraft,
  type BoardState, type Draft, type LockedDraft,
} from './schedule-board.service';

const CONFLICTS = 'Fix the conflicts before publishing.';
const NOTHING_TO_PUBLISH = 'There are no meetings to publish yet. Generate the board first.';
const NOT_FOUND = "We couldn't find that event.";
const PARTICIPANTS_ONLY = 'Only the people taking part in this event can see its meetings.';
const BELL_BODY = 'See who you meet in each round on the event page.';
/** The versions list shows the latest ones; an event publishes a handful, the product a few more while live. */
const VERSIONS_SHOWN = 100;

// ─── What a version would change ─────────────────────────────────────────────

/** Each person's meeting in one round of a version: the sorted people of their room, '' when they meet nobody. */
function meetingsIn(snapshot: ScheduleSnapshot | null, round: number): Map<string, string> {
  const out = new Map<string, string>();
  const rooms = snapshot?.rounds.find((r) => r.round === round)?.rooms ?? [];
  for (const room of rooms) {
    if (room.userIds.length < 2) continue;
    const key = [...room.userIds].sort().join(',');
    for (const id of room.userIds) out.set(id, key);
  }
  return out;
}

/**
 * The people whose meetings differ between two versions in the rounds `open` keeps (rounds not yet started): someone
 * now meets other people, or meets nobody, or meets someone where they met nobody. A room that only changed its
 * number changes nobody's meetings. Only people still in the event (a place that is not removed, not running it).
 */
export function impactedBetween(
  state: BoardState, previous: ScheduleSnapshot | null, next: ScheduleSnapshot, open: (round: number) => boolean,
): string[] {
  const impacted = new Set<string>();
  const rounds = new Set([...(previous?.rounds ?? []), ...next.rounds].map((r) => r.round));
  for (const round of rounds) {
    if (!open(round)) continue;
    const before = meetingsIn(previous, round);
    const after = meetingsIn(next, round);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if ((before.get(id) ?? '') !== (after.get(id) ?? '')) impacted.add(id);
    }
  }
  return [...impacted].filter((id) => {
    const status = state.people.get(id)?.participantStatus;
    return !!status && status !== 'removed' && !state.hostIds.has(id);
  }).sort();
}

const openRound = (state: BoardState) => (round: number) => round <= state.numberOfRounds && isEditable(state, round);

/** The organiser's sentence for each problem of the rounds not yet started: what blocks publishing, what it keeps. */
export function previewItems(state: BoardState, draft: Draft): { blocking: PublishPreviewItem[]; warnings: PublishPreviewItem[] } {
  const blocking: PublishPreviewItem[] = [];
  const warnings: PublishPreviewItem[] = [];
  const names = (ids: string[]) => andList(ids.map((id) => nameOf(state, id)));
  let seated = 0;
  for (let round = 1; round <= state.numberOfRounds; round++) {
    if (!isEditable(state, round)) continue;
    const r = buildRound(state, draft, round);
    for (const id of r.collisions) blocking.push({ round, room: null, message: `${nameOf(state, id)} has two seats in round ${round}.` });
    for (const room of r.rooms) {
      seated += room.seats.length;
      const at = (message: string) => ({ round, room: room.roomNumber, message });
      for (const problem of room.verdict.problems) {
        blocking.push(at(problem.kind === 'too_many'
          ? `Room ${room.roomNumber} has more than three people.`
          : problemMessage(state, round, problem, problem.userIds[0])));
      }
      for (const seat of room.seats) {
        if (seat.status === 'not_in_event') blocking.push(at(`${seat.displayName} isn't taking part in this event's meetings any more.`));
      }
      for (const warning of room.verdict.warnings) {
        if (warning.kind === 'repeat') warnings.push(at(`${names(warning.userIds)} have met before.`));
        if (warning.kind !== 'vacancy') continue;
        if (room.seats.length === 0) warnings.push(at(`Room ${room.roomNumber} is locked but has nobody in it.`));
        else if (room.seats.length === 1 && warning.userIds.length === 1 && warning.userIds[0] === room.seats[0].userId
          && room.seats[0].status !== 'absent' && room.seats[0].status !== 'left' && room.seats[0].status !== 'no_show') {
          warnings.push(at(`${room.seats[0].displayName} is alone in room ${room.roomNumber}, so they wait this round.`));
        } else {
          const one = warning.userIds.length === 1;
          warnings.push(at(`${names(warning.userIds)} ${one ? "isn't" : "aren't"} expected, so room ${room.roomNumber} has a gap.`));
        }
      }
    }
    const waiting = r.basket.filter((p) => p.status !== 'left' && p.status !== 'no_show');
    if (waiting.length > 0) {
      const one = waiting.length === 1;
      warnings.push({ round, room: null, message: `${names(waiting.map((p) => p.userId))} ${one ? 'has' : 'have'} no meeting in round ${round}.` });
    }
    if (r.capacity?.sentence) warnings.push({ round, room: null, message: r.capacity.sentence });
  }
  if (seated === 0 && state.numberOfRounds >= 1 && isEditable(state, 1)) blocking.unshift({ round: 1, room: null, message: NOTHING_TO_PUBLISH });
  return { blocking, warnings };
}

/** What publishing the board now would do, for an organiser of the event. Reads only. */
export async function previewPublish(sessionId: string, actor: Actor): Promise<PublishPreview> {
  await requireOrganiser(sessionId, actor);
  const state = await loadState(sessionId);
  const { blocking, warnings } = isEnded(state) ? { blocking: [], warnings: [] } : previewItems(state, state.draft);
  return {
    blocking,
    // The rooms the live event changed while this draft had its own changes come first: they are what to check.
    warnings: [...state.liveConflicts, ...warnings],
    impactedUserIds: impactedBetween(state, state.published, snapshotOf(state, state.draft), openRound(state)),
    nextVersion: (state.publishedVersion ?? 0) + 1,
  };
}

// ─── Publishing ──────────────────────────────────────────────────────────────

export interface PublishedVersion {
  version: number;
  impactedUserIds: string[];
  /** The event's first version. */
  first: boolean;
  /** Published while the event was live (its rounds not yet started are rewritten in `matches`). */
  live: boolean;
  automatic: boolean;
  actorId: string | null;
  /** The board's revision after the publish: every publish moves it, so a repeated click is answered SCHEDULE_CHANGED. */
  revision: number;
}

/**
 * Write `draft` as the event's next version, inside the caller's locked draft (one transaction with whatever the
 * caller changed): the version row (never changed again), the board's published version, and one
 * `schedule.published` audit row carrying the version number. Nothing is announced here: call announcePublished
 * once the transaction has committed.
 */
export async function publishLocked(
  locked: LockedDraft, draft: Draft,
  by: { actorId: string | null; automatic: boolean; reason: string | null; note: string | null; settlesConflicts?: boolean },
): Promise<PublishedVersion> {
  const { client, state } = locked;
  const latest = await client.query<{ version: number; snapshot: ScheduleSnapshot | string }>(
    `SELECT version, snapshot FROM event_schedule_versions WHERE session_id = $1 ORDER BY version DESC LIMIT 1`,
    [state.sessionId],
  );
  const previous = latest.rows[0];
  const previousSnapshot = !previous ? null
    : typeof previous.snapshot === 'string' ? JSON.parse(previous.snapshot) as ScheduleSnapshot : previous.snapshot;
  const version = (previous?.version ?? 0) + 1;
  const snapshot = snapshotOf(state, draft);
  const impactedUserIds = impactedBetween(state, previousSnapshot, snapshot, openRound(state));
  await client.query(
    `INSERT INTO event_schedule_versions (session_id, version, published_by, automatic, reason, note, impacted_count, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [state.sessionId, version, by.actorId, by.automatic, by.reason, by.note, impactedUserIds.length, JSON.stringify(snapshot)],
  );
  // The revision moves too: the draft did not change, but a second click made against the same board is then refused
  // (SCHEDULE_CHANGED) instead of publishing the same rooms again. An organiser's publish settles the live conflicts.
  const moved = await client.query<{ revision: number }>(
    `UPDATE event_schedules
        SET published_version = $2, revision = revision + 1, updated_at = NOW(),
            live_conflicts = CASE WHEN $3::boolean THEN '[]'::jsonb ELSE live_conflicts END
      WHERE session_id = $1
      RETURNING revision`,
    [state.sessionId, version, by.settlesConflicts === true],
  );
  await recordEventAudit({
    sessionId: state.sessionId,
    actorId: by.actorId,
    action: 'schedule.published',
    automatic: by.automatic,
    scheduleVersion: version,
    subjectUserIds: impactedUserIds,
    before: { version: previous?.version ?? null },
    after: { version, impactedCount: impactedUserIds.length, ...(by.note && { note: by.note }) },
    ...(by.reason && { reason: by.reason }),
  }, client);
  return {
    version, impactedUserIds, first: !previous, live: isLiveStatus(state.status), automatic: by.automatic, actorId: by.actorId,
    revision: moved.rows[0]?.revision ?? state.revision + 1,
  };
}

/**
 * After a version committed: the organisers' boards and everyone in the event are told, and the people whose meetings
 * changed get one bell each, unless this is the first version of an event not yet live. Never throws.
 */
export async function announcePublished(sessionId: string, published: PublishedVersion): Promise<void> {
  void fanoutScheduleDraft(sessionId, published.actorId ?? undefined);
  void fanoutPublishedSchedule(sessionId, published.actorId);
  void emitEventAuditChanged(sessionId);
  if ((published.first && !published.live) || published.impactedUserIds.length === 0) return;
  try {
    const event = await query<{ title: string | null }>(`SELECT title FROM sessions WHERE id = $1`, [sessionId]);
    const title = event.rows[0]?.title?.trim() || 'your event';
    await ringEventBells(
      'event_schedule_changed',
      published.impactedUserIds.map((userId) => ({ userId, title: `Your meetings for ${title} changed` })),
      BELL_BODY,
      eventPagePath(sessionId),
    );
  } catch (err) {
    logger.warn({ err, sessionId, version: published.version }, 'Schedule published, its bells were not all rung (non-fatal)');
  }
}

/**
 * Publish the board as the event's next version. `actor` null is the product itself (`automatic`), which publishes
 * what the draft holds even with conflicts: the live matches never seat a room the checker refuses either way
 * (schedule-live.service.ts checks every room it writes). An organiser's publish is refused while anything blocks.
 */
export async function publishSchedule(
  sessionId: string, actor: Actor | null, expectedRevision: number,
  opts: { note?: string; automatic?: boolean; reason?: string } = {},
): Promise<PublishResult> {
  if (actor) await requireOrganiser(sessionId, actor);
  const automatic = actor === null || opts.automatic === true;
  const prep = await prepareWrite(sessionId, false);
  const outcome = await withLockedDraft(sessionId, prep, expectedRevision, async (locked): Promise<PublishedVersion | PublishResult> => {
    const { state } = locked;
    if (isEnded(state)) throw new ConflictError(ErrorCodes.EVENT_ENDED, ENDED);
    // The draft is what is already published: nothing is written, the current version is the answer.
    if (state.published && state.publishedVersion !== null && sameSnapshot(snapshotOf(state, state.draft), state.published)) {
      return { version: state.publishedVersion, impactedUserIds: [], revision: state.revision };
    }
    const { blocking } = previewItems(state, state.draft);
    if (blocking.length > 0) throw new ConflictError(ErrorCodes.SCHEDULE_HAS_CONFLICTS, CONFLICTS, { blocking });
    return publishLocked(locked, state.draft, {
      actorId: actor?.userId ?? null, automatic, reason: opts.reason?.trim() || null, note: opts.note?.trim() || null,
      settlesConflicts: !automatic,
    });
  });
  if (outcome.stale) {
    throw new ConflictError(ErrorCodes.SCHEDULE_CHANGED, STALE, actor ? { board: await readBoard(sessionId, actor) } : undefined);
  }
  const published = outcome.value;
  if (!('first' in published)) return published;
  await announcePublished(sessionId, published);
  if (published.live) {
    // Loaded when used: the live service loads this one for its own versions.
    const live = await import('./schedule-live.service');
    await live.materialiseAfterPublish(sessionId);
  }
  return { version: published.version, impactedUserIds: published.impactedUserIds, revision: published.revision };
}

// ─── Reading versions ────────────────────────────────────────────────────────

/** The event's versions, latest first, for its organisers. */
export async function listScheduleVersions(sessionId: string, actor: Actor): Promise<ScheduleVersionSummary[]> {
  await requireOrganiser(sessionId, actor);
  const result = await query<{
    version: number; created_at: Date | string; published_by: string | null; display_name: string | null; active: boolean | null;
    automatic: boolean; reason: string | null; note: string | null; impacted_count: number;
  }>(
    `SELECT v.version, v.created_at, v.published_by, u.display_name, (u.status = 'active') AS active,
            v.automatic, v.reason, v.note, v.impacted_count
       FROM event_schedule_versions v
       LEFT JOIN users u ON u.id = v.published_by
      WHERE v.session_id = $1
      ORDER BY v.version DESC
      LIMIT $2`,
    [sessionId, VERSIONS_SHOWN],
  );
  return result.rows.map((r) => ({
    version: r.version,
    publishedAt: new Date(r.created_at).toISOString(),
    publishedBy: r.published_by
      ? { userId: r.published_by, displayName: r.active && r.display_name?.trim() ? r.display_name.trim() : FORMER_MEMBER_NAME }
      : null,
    automatic: r.automatic,
    reason: r.reason,
    note: r.note,
    impactedCount: r.impacted_count,
  }));
}

function configOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

/**
 * A participant's own meetings in the latest published version: for each round, their room and who they meet (names,
 * pictures and the event's group labels), or no room. Never the draft. Null before the first version. Anyone with a
 * place in the event (an event guest too) and its organisers may read it; an event that does not exist reads as not
 * found, and anyone else is refused.
 */
export async function getMySchedule(sessionId: string, userId: string): Promise<MySchedule | null> {
  const event = await query<{ config: unknown; scheduled_at: string | Date | null }>(
    `SELECT config, scheduled_at FROM sessions WHERE id = $1`, [sessionId],
  );
  if (!event.rows[0]) throw new NotFoundError('Session', sessionId, NOT_FOUND);
  const place = await query<{ status: string }>(
    `SELECT status::text AS status FROM session_participants WHERE session_id = $1 AND user_id = $2`, [sessionId, userId],
  );
  const hasPlace = !!place.rows[0] && place.rows[0].status !== 'removed';
  if (!hasPlace) {
    const role = await query<{ role: UserRole }>(`SELECT role FROM users WHERE id = $1`, [userId]);
    const { allowed } = await canActAsHost(userId, role.rows[0]?.role ?? UserRole.MEMBER, sessionId);
    if (!allowed) throw new ForbiddenError(PARTICIPANTS_ONLY);
  }
  const latest = await query<{ version: number; created_at: Date | string; snapshot: ScheduleSnapshot | string }>(
    `SELECT version, created_at, snapshot FROM event_schedule_versions WHERE session_id = $1 ORDER BY version DESC LIMIT 1`,
    [sessionId],
  );
  const row = latest.rows[0];
  if (!row) return null;
  const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) as ScheduleSnapshot : row.snapshot;
  const config = configOf(event.rows[0].config);
  const starts = estimatedRoundStarts(event.rows[0].scheduled_at, {
    numberOfRounds: snapshot.rounds.length,
    roundDurationSeconds: Number(config.roundDurationSeconds) || 0,
    ratingWindowSeconds: Number(config.ratingWindowSeconds) || 0,
  });
  const mine = snapshot.rounds.map((r) => ({ round: r.round, room: r.rooms.find((room) => room.userIds.includes(userId)) ?? null }));
  const partnerIds = [...new Set(mine.flatMap((m) => m.room?.userIds ?? []).filter((id) => id !== userId))];
  const people = partnerIds.length === 0 ? new Map<string, { name: string; avatar: string | null }>() : new Map((await query<{
    id: string; display_name: string | null; avatar_url: string | null; active: boolean;
  }>(
    `SELECT id, display_name, avatar_url, (status = 'active') AS active FROM users WHERE id = ANY($1::uuid[])`, [partnerIds],
  )).rows.map((u) => [u.id, {
    name: u.active && u.display_name?.trim() ? u.display_name.trim() : FORMER_MEMBER_NAME,
    avatar: u.active ? u.avatar_url : null,
  }]));
  const rules = partnerIds.length > 0 ? await getEventGroupRules(sessionId) : null;
  const groups = rules ? await groupsForParticipants(sessionId) : new Map<string, string[]>();
  const labelOf = new Map((rules?.groups ?? []).map((g) => [g.key, g.label]));
  return {
    version: row.version,
    publishedAt: new Date(row.created_at).toISOString(),
    rounds: mine.map(({ round, room }) => ({
      round,
      startsAt: starts[round - 1] ?? null,
      room: room && room.userIds.length >= 2 ? room.room : null,
      partners: !room || room.userIds.length < 2 ? [] : room.userIds.filter((id) => id !== userId).map((id) => ({
        displayName: people.get(id)?.name ?? FORMER_MEMBER_NAME,
        avatarUrl: people.get(id)?.avatar ?? null,
        groupLabels: (groups.get(id) ?? []).map((k) => labelOf.get(k)).filter((l): l is string => !!l),
      })),
    })),
  };
}
