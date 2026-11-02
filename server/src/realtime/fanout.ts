// ─── Realtime fanout helpers (entity-only) ──────────────────────────────────
//
// Replaces the legacy `notifyPodChanged` / `notifySessionListChanged` /
// `notifyAdminListChanged` / etc. wrappers deleted in Phase 5 of the
// realtime architecture migration. Each helper here:
//   1. resolves the recipient set with the same SELECT the legacy wrapper
//      used (pod_members for pod-scoped, session_participants ∪ pod_members
//      for session-scoped, users with admin role for admin-scoped, etc.),
//   2. calls emitEntities(...) with the domain-entity tags that describe
//      what changed.
//
// CRUCIALLY: none of these helpers emit a bespoke socket event like
// `pod:membership_updated` or `session:list_changed`. The entity-tag pipeline
// is the only realtime contract; clients invalidate React-Query caches via
// the global useEntityChangedHandler matching `meta.entities`.
//
// The TWO events kept across Phase 5 — `permissions:updated` and
// `roster:changed` — live in `emitPermissionsUpdated` below. They survive
// because `useSessionSocket` hydrates Zustand state (cohorts, overrides,
// host visibility modes) from the snapshot when these arrive, which the
// React-Query entity invalidator can't do.
//
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md

import logger from '../config/logger';
import { activeMemberSql } from '../services/users/active-member';
import { emitEntities, getRealtimeIo } from './emit';
import { E } from './entities';

/**
 * T13 (1 Nov 2026): an event for a whole circle has the circle's active members in its audience as well as its
 * pod's (event-access.ts). One UNION arm, for the event in `$1`, so every helper below that tells an event's
 * people about a change to it (renamed, rescheduled, cancelled, started, deleted) tells them too.
 */
const CIRCLE_AUDIENCE_ARM = `
     SELECT cm.user_id FROM circle_members cm
       JOIN sessions cs ON cs.circle_id = cm.circle_id
       JOIN users cu ON cu.id = cm.user_id
      WHERE cs.id = $1 AND ${activeMemberSql('cu')}`;

// ─── Pod-scoped fanout ──────────────────────────────────────────────────────
//
// Resolves every currently-attached pod member (excluding 'removed' /
// 'declined' rows so soft-deleted users don't get refetches) and emits the
// pod + members + invites entities by default. Callers can pass extra
// entities (e.g., `E.podSessions(podId)` for session-list-affecting
// mutations, or `E.userPods(memberId)` for member-add/remove) and they're
// concatenated.

export async function fanoutPodEntities(
  podId: string,
  extraEntities: string[] = [],
  options: { includeUserPodsPerMember?: boolean } = {},
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM pod_members
        WHERE pod_id = $1 AND status NOT IN ('removed', 'declined')`,
      [podId],
    );
    const userIds = result.rows.map(r => r.user_id);
    const entities = [E.pod(podId), E.podMembers(podId), E.podInvites(podId), ...extraEntities];
    if (options.includeUserPodsPerMember) {
      // Pod-wide mutations (delete, reactivate, hard-delete) also flip each
      // member's "My Pods" list. Tag the per-recipient userPods entities so
      // every receiving client's user:${currentUserId}:pods query refetches.
      for (const id of userIds) entities.push(E.userPods(id));
    }
    await emitEntities(io, userIds, entities);
  } catch (err) {
    logger.warn({ err, podId }, 'fanoutPodEntities: failed to fan out');
  }
}

// ─── Pod-membership-for-user fanout ─────────────────────────────────────────
//
// Targets a SINGLE user with pod + members + userPods entities. Used when
// an action affects a user who may already be soft-removed (so they wouldn't
// be in fanoutPodEntities' active-member SELECT) — e.g., the leaver in
// POST /pods/:id/leave or the rejected applicant in approve/reject paths.

export async function fanoutPodMembershipForUser(
  podId: string,
  userId: string,
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(
      io,
      [userId],
      [E.pod(podId), E.podMembers(podId), E.userPods(userId)],
    );
  } catch (err) {
    logger.warn({ err, podId, userId }, 'fanoutPodMembershipForUser: failed to fan out');
  }
}

// ─── Pod wall fanout (26 Oct 2026) ──────────────────────────────────────────
//
// A pod's wall changed: a post was made, deleted or pinned, a comment or reaction moved a count, a
// comment was liked. The audience is the pod's ACTIVE members and nobody else, because only they can
// read the wall; fanoutPodEntities is not used since it also re-tags the pod, its members and its
// invites, and reaches invited, pending and left rows.
//
// Sends `pod:<podId>:wall` (the feed and its counts) plus the tags a caller names, such as
// `pod-wall-post:<postId>` (one post's thread). `wall: false` leaves the feed's tag out for a change
// only a thread shows (a like on a comment), so a like does not refetch every member's loaded feed.

export async function fanoutPodWall(
  podId: string,
  extraEntities: string[] = [],
  options: { wall?: boolean } = {},
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM pod_members WHERE pod_id = $1 AND status = 'active'`,
      [podId],
    );
    const entities = [...(options.wall === false ? [] : [E.podWall(podId)]), ...extraEntities];
    await emitEntities(io, result.rows.map(r => r.user_id), entities);
  } catch (err) {
    logger.warn({ err, podId }, 'fanoutPodWall: failed to fan out');
  }
}

// ─── Session-scoped fanout ──────────────────────────────────────────────────
//
// Mirrors the legacy notifySessionListChanged audience: anyone who is a
// session participant OR a member of the pod the session lives under, plus
// (T13) the active members of the circle a circle event is for. Emits
// session + sessionParticipants + (optional) podSessions by default.

export async function fanoutSessionEntities(
  podId: string | null,
  sessionId: string,
  extraEntities: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
       UNION
       SELECT user_id FROM pod_members
         WHERE pod_id = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
           AND status NOT IN ('removed', 'declined')
       UNION${CIRCLE_AUDIENCE_ARM}`,
      [sessionId, podId],
    );
    const entities: string[] = [E.session(sessionId), E.sessionParticipants(sessionId)];
    if (podId) entities.push(E.podSessions(podId));
    entities.push(...extraEntities);
    await emitEntities(io, result.rows.map(r => r.user_id), entities);
  } catch (err) {
    logger.warn({ err, sessionId, podId }, 'fanoutSessionEntities: failed to fan out');
  }
}

// ─── Event-list fanout ──────────────────────────────────────────────────────
//
// An event (the sessions table) was created, renamed, rescheduled, cancelled
// or deleted. The lists that show it belong to the member: Home and Sessions
// (`user:<id>:sessions`), and the pods list that counts each pod's events and
// the For You "next event" panel that follows the member's pods
// (`user:<id>:pods`). A tag that names a member is only ever matched by that
// member's own client, so each recipient is sent their own two tags and not
// everyone's: the payload stays two tags long however big the pod is, and no
// client is told another member's id.
//
// Audience: the event's participants, its pod's members, its host and, for an
// event for a whole circle, the circle's active members (T13). The host
// is read on its own because a host who has left their own event, or an admin
// who runs one in a pod they do not belong to, is in neither of the others.

/**
 * Everyone who could be looking at this event in a list. A permanent delete
 * takes the participants and the host with the event, so a caller that deletes
 * reads this first and passes it to fanoutSessionListEntities afterwards.
 */
export async function resolveSessionListAudience(
  podId: string | null,
  sessionId: string,
): Promise<string[]> {
  const { query } = await import('../db');
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants
       WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
     UNION
     SELECT user_id FROM pod_members
       WHERE pod_id = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
         AND status NOT IN ('removed', 'declined')
     UNION
     SELECT host_user_id FROM sessions
       WHERE id = $1 AND host_user_id IS NOT NULL
     UNION${CIRCLE_AUDIENCE_ARM}`,
    [sessionId, podId],
  );
  return result.rows.map(r => r.user_id);
}

export async function fanoutSessionListEntities(
  podId: string | null,
  sessionId: string,
  /** Read earlier by a caller whose delete takes the rows that name the audience. */
  audience?: string[],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const recipients = new Set(audience ?? await resolveSessionListAudience(podId, sessionId));
    await Promise.all([...recipients].filter(Boolean).map(userId =>
      emitEntities(io, [userId], [E.userSessions(userId), E.userPods(userId)]),
    ));
  } catch (err) {
    logger.warn({ err, sessionId, podId }, 'fanoutSessionListEntities: failed to fan out');
  }
}

// ─── Event-completed fanout (26 Oct 2026) ───────────────────────────────────
//
// An event ended (completeSession). Every page that shows it must flip to "Ended" and its chat must be read
// in full, without a refresh: the event page, the pod's events, Home and Sessions, the For You next event.
// Audience: its participants, INCLUDING those who already left (the end-of-event sweep marks everyone
// left while this runs, so fanoutSessionEntities' "not left" audience would miss nearly everyone), less
// anyone removed before they ever joined; its host and co-hosts; its pod's active members. Each person is
// sent, in one emit of their own, the event's tags and their own two list tags:
//   session:<id>, session:<id>:participants, session:<id>:chat, pod:<podId>:sessions,
//   user:<recipient>:sessions, user:<recipient>:pods.
// Never throws: a failure here is logged and the completion carries on.

export async function fanoutSessionCompleted(sessionId: string): Promise<void> {
  try {
    const io = getRealtimeIo();
    if (!io) return;
    const { query } = await import('../db');
    const event = await query<{ pod_id: string | null }>(`SELECT pod_id FROM sessions WHERE id = $1`, [sessionId]);
    if (event.rows.length === 0) return;
    const podId = event.rows[0].pod_id;
    const people = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND (joined_at IS NOT NULL OR status <> 'removed')
       UNION
       SELECT host_user_id FROM sessions WHERE id = $1
       UNION
       SELECT user_id FROM session_cohosts WHERE session_id = $1
       UNION
       SELECT user_id FROM pod_members
         WHERE pod_id = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid) AND status = 'active'`,
      [sessionId, podId],
    );
    const shared = [E.session(sessionId), E.sessionParticipants(sessionId), E.sessionChat(sessionId)];
    if (podId) shared.push(E.podSessions(podId));
    const recipients = new Set(people.rows.map((r) => r.user_id).filter(Boolean));
    await Promise.all([...recipients].map((userId) =>
      emitEntities(io, [userId], [...shared, E.userSessions(userId), E.userPods(userId)]),
    ));
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutSessionCompleted: failed to fan out');
  }
}

// ─── Event-chat fanout (26 Oct 2026) ────────────────────────────────────────
//
// The event's chat changed after the fact: a message was taken down. Sent to the people who can read it (those
// who took part, the host, the co-hosts) and to whoever took it down, so their other tabs follow. Live messages
// are not announced this way: the live panel receives them on chat:message.

export async function fanoutSessionChat(sessionId: string, actorId?: string): Promise<void> {
  try {
    const io = getRealtimeIo();
    if (!io) return;
    const { query } = await import('../db');
    const readers = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND joined_at IS NOT NULL AND status <> 'removed'
       UNION
       SELECT host_user_id FROM sessions WHERE id = $1
       UNION
       SELECT user_id FROM session_cohosts WHERE session_id = $1`,
      [sessionId],
    );
    const recipients = [...readers.rows.map((r) => r.user_id), ...(actorId ? [actorId] : [])];
    await emitEntities(io, recipients, [E.sessionChat(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'fanoutSessionChat: failed to fan out');
  }
}

// ─── Admin-list fanout ──────────────────────────────────────────────────────
//
// Targets every admin / super_admin user's room. `scope` plugs into the
// entity tag (`admin:${scope}`) so a new admin list can be added without a
// signature bump.

export async function fanoutAdminEntities(
  scope: string,
  extraEntities: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ id: string }>(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin')`,
    );
    await emitEntities(
      io,
      result.rows.map(r => r.id),
      [`admin:${scope}`, ...extraEntities],
    );
  } catch (err) {
    logger.warn({ err, scope }, 'fanoutAdminEntities: failed to fan out');
  }
}

// ─── An admin changed an account's status (T2, 1 Nov 2026) ──────────────────
//
// Removing, suspending, banning or reactivating an account changes what everyone around it sees: the person leaves
// (or comes back to) pod member lists and counts, event participant lists, People, and their name turns into
// "Former member" (or back) in old conversations, group chats and pod walls. Nothing about the memberships changes,
// so the audience is read from them: the members of every pod the account is in or asked to join (pod tags and the
// pod's wall), the people of every event it holds a place in that has not ended (the event's participant tags), each
// of its connections and conversation partners (their own Messages and People, `user:<id>:dms`), and each group chat
// it is in, and every circle it is in (the circle's page and its member list, through fanoutCircleChange, with the
// person counted as a changed member so lists that show their circles redraw).

/** The most connections one status change tells live. */
export const ACCOUNT_AUDIENCE_PEOPLE_MAX = 2000;

/** Who could be looking at an account, read from its memberships. */
export interface AccountAudience {
  podIds: string[];
  events: Array<{ podId: string | null; sessionId: string }>;
  people: string[];
  groupIds: string[];
  circleIds: string[];
}

export async function accountAudience(userId: string): Promise<AccountAudience> {
  const { query } = await import('../db');
  const { CONNECTION_SIGNALS_SQL } = await import('../services/people/connections.service');
  const [pods, events, people, groups, circles] = await Promise.all([
    query<{ pod_id: string }>(
      `SELECT pod_id FROM pod_members WHERE user_id = $1 AND status IN ('active', 'pending_approval')`,
      [userId],
    ),
    query<{ session_id: string; pod_id: string | null }>(
      `SELECT sp.session_id, s.pod_id FROM session_participants sp JOIN sessions s ON s.id = sp.session_id
        WHERE sp.user_id = $1 AND sp.status <> 'removed' AND s.status NOT IN ('completed', 'cancelled')`,
      [userId],
    ),
    // Bounded (CLAUDE.md §7): the newest connections first; anyone past the cap catches up on their next read.
    query<{ person_id: string }>(
      `WITH ${CONNECTION_SIGNALS_SQL} SELECT person_id FROM people WHERE person_id <> $1 ORDER BY since DESC LIMIT ${ACCOUNT_AUDIENCE_PEOPLE_MAX}`,
      [userId],
    ),
    query<{ group_id: string }>(`SELECT group_id FROM dm_group_members WHERE user_id = $1`, [userId]),
    query<{ circle_id: string }>(`SELECT circle_id FROM circle_members WHERE user_id = $1`, [userId]),
  ]);
  return {
    podIds: pods.rows.map(r => r.pod_id),
    events: events.rows.map(r => ({ podId: r.pod_id, sessionId: r.session_id })),
    people: people.rows.map(r => r.person_id),
    groupIds: groups.rows.map(r => r.group_id),
    circleIds: circles.rows.map(r => r.circle_id),
  };
}

export async function fanoutAccountAudience(audience: AccountAudience, userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await Promise.all([
      ...audience.podIds.map(podId => Promise.all([fanoutPodEntities(podId), fanoutPodWall(podId)])),
      ...audience.events.map(e => fanoutSessionEntities(e.podId, e.sessionId)),
      ...audience.people.map(personId => emitEntities(io, [personId], [E.userDms(personId)])),
      ...audience.groupIds.map(groupId => fanoutGroupEntities(groupId)),
      ...audience.circleIds.map(circleId => fanoutCircleChange(circleId, userId, [userId])),
    ]);
  } catch (err) {
    logger.warn({ err }, 'fanoutAccountAudience: failed to fan out');
  }
}

export async function fanoutAccountStatusChange(userId: string): Promise<void> {
  if (!getRealtimeIo()) return;
  try {
    await fanoutAccountAudience(await accountAudience(userId), userId);
  } catch (err) {
    logger.warn({ err, userId }, 'fanoutAccountStatusChange: failed to fan out');
  }
}

// ─── Single-user notifications fanout ───────────────────────────────────────
//
// Cross-tab notification list update for ONE user (mark-read, mark-all-read,
// clear-all). Other tabs / devices the same user has open invalidate their
// notifications query and the bell counter refreshes.

export async function fanoutOwnNotifications(userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, [userId], [E.userNotifications(userId)]);
  } catch (err) {
    logger.warn({ err, userId }, 'fanoutOwnNotifications: failed to fan out');
  }
}

// ─── User-blocks fanout ─────────────────────────────────────────────────────
//
// Targets both the blocker and the blocked user with each side's userBlocks
// entity. Used for block / unblock mutations.
//
// 26 Oct 2026: and each person's own bell. A meeting request reads as gone in
// the bell while a block stands between the two people, whichever of them made
// it (GET /notifications), so a block or an unblock changes both bells, and an
// open bell must redraw without waiting for its next fetch.

export async function fanoutUserBlocks(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(
      io,
      [blockerId, blockedId],
      [E.userBlocks(blockerId), E.userBlocks(blockedId)],
    );
    await emitEntities(io, [blockerId], [E.userNotifications(blockerId)]);
    await emitEntities(io, [blockedId], [E.userNotifications(blockedId)]);
  } catch (err) {
    logger.warn({ err, blockerId, blockedId }, 'fanoutUserBlocks: failed to fan out');
  }
}

// ─── Single-user entity fanout ──────────────────────────────────────────────
//
// Emits the user-scope entity to a specific user's room. Used when admin
// routes mutate a user (role / status / delete / entitlements / poke result)
// so the affected user's own UI flips state in real time.

export async function fanoutUserEntity(
  userId: string,
  extraEntities: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, [userId], [E.user(userId), ...extraEntities]);
  } catch (err) {
    logger.warn({ err, userId }, 'fanoutUserEntity: failed to fan out');
  }
}

// ─── Entity fanout (21 Oct 2026) ────────────────────────────────────────────
//
// An entity (an organisation members create, such as a company or a fund; not the realtime "entities"
// these tags are) was created, edited or archived, or a member joined it, changed their role in it or
// left it. T15 (30 Oct review): also someone claims to be part of it or asks to change their role, an
// admin approves, declines or removes, its logo or banner changes, or it is linked to or unlinked from a
// circle. Audience: its people as they are after the write (an archive keeps them; active and pending
// links), the member who acted, and each member whose link changed (one who has just left, or was
// declined or removed, is no longer among its people).
// Each recipient is sent, in an emit of their own:
//   entity:<id>                its page;
//   user:<recipient>:entities  their own list, whose names and people counts may have moved;
//   user:<changed>:entities    for each member whose link changed, so a profile that lists that
//                              member's entities redraws for the people who share the entity.
// Someone outside the entity with its page, or a member's profile, open is not told, and catches up
// on focus, as with an event in a pod they are not in.

export async function fanoutEntityChange(
  entityId: string,
  actorId: string,
  changedUserIds: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const { openLinkSql } = await import('../services/entity/entity-links');
    // T15: its listed people and the people whose claims wait (their own screens show where the claim stands); a
    // declined or removed person is told only as a changed user.
    const people = await query<{ user_id: string }>(
      `SELECT m.user_id FROM entity_members m WHERE m.entity_id = $1 AND ${openLinkSql('m')}`,
      [entityId],
    );
    const recipients = new Set([...people.rows.map(r => r.user_id), actorId, ...changedUserIds].filter(Boolean));
    const told = [E.entity(entityId), ...changedUserIds.map(E.userEntities)];
    await Promise.all([...recipients].map(userId =>
      emitEntities(io, [userId], [...new Set([...told, E.userEntities(userId)])]),
    ));
  } catch (err) {
    logger.warn({ err, entityId }, 'fanoutEntityChange: failed to fan out');
  }
}

// ─── Circle-change fanout ───────────────────────────────────────────────────
//
// 1 Nov 2026. Everyone a change to a circle can touch hears it, as the circle is after the write:
//   circle:<id>, circle:<id>:members  its page, with who is in it and the counts;
//   user:<recipient>:circles          their own Circles list, whose names and counts may have moved;
//   user:<changed>:circles            for each member whose link changed, so a list that shows that member's
//                                     circles redraws for the people who share the circle.
// The audience is the circle's members, the person who made it (its creator manages it even with no member row),
// the platform admins (final fix wave X3, 2 Nov 2026: they run every circle, L21, so their open Requests panel and
// request count follow an ask or an answer; read bounded, CIRCLE_CHANGE_ADMINS_MAX), the actor and the changed people.
// A circle's invites change through `extra` (circle:<id>:invites). Someone outside the circle with its page open is
// not told, and catches up on focus, as with an entity. The circle's wall keeps its own refresh and is not told.
//
// Final fix wave S1 (2 Nov 2026): circle membership decides who sees, auto-registers for and registers for a circle's
// events (event-access.ts), so each changed person is also sent, in their own emit only:
//   user:<changed>:sessions           their own Home and Events lists;
//   session:<id>                      the page of each of the circle's events that has not ended (at most
//                                     CIRCLE_CHANGE_EVENTS_MAX, the soonest first; idx_sessions_circle).
// The emits go in batches of CIRCLE_EVENT_FANOUT_BATCH.

export const CIRCLE_CHANGE_ADMINS_MAX = 200;
export const CIRCLE_CHANGE_EVENTS_MAX = 50;

export async function fanoutCircleChange(
  circleId: string,
  actorId: string,
  changedUserIds: string[] = [],
  extra: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const people = await query<{ user_id: string }>(
      `SELECT user_id FROM circle_members WHERE circle_id = $1
       UNION
       SELECT created_by FROM circles WHERE id = $1`,
      [circleId],
    );
    const admins = await query<{ user_id: string }>(
      `SELECT u.id AS user_id FROM users u
        WHERE u.role IN ('admin', 'super_admin') AND ${activeMemberSql('u')}
        ORDER BY u.id LIMIT $1`,
      [CIRCLE_CHANGE_ADMINS_MAX],
    );
    const upcoming = changedUserIds.length === 0 ? [] : (await query<{ id: string }>(
      `SELECT id FROM sessions WHERE circle_id = $1 AND status NOT IN ('completed', 'cancelled')
        ORDER BY scheduled_at NULLS LAST, id LIMIT $2`,
      [circleId, CIRCLE_CHANGE_EVENTS_MAX],
    )).rows.map(r => E.session(r.id));
    const changed = new Set(changedUserIds);
    const recipients = [...new Set(
      [...people.rows.map(r => r.user_id), ...admins.rows.map(r => r.user_id), actorId, ...changedUserIds].filter(Boolean),
    )];
    const told = [E.circle(circleId), E.circleMembers(circleId), ...changedUserIds.map(E.userCircles), ...extra];
    const tagsFor = (userId: string) => [...new Set([
      ...told, E.userCircles(userId), ...(changed.has(userId) ? [E.userSessions(userId), ...upcoming] : []),
    ])];
    for (let i = 0; i < recipients.length; i += CIRCLE_EVENT_FANOUT_BATCH) {
      await Promise.all(recipients.slice(i, i + CIRCLE_EVENT_FANOUT_BATCH).map(userId =>
        emitEntities(io, [userId], tagsFor(userId)),
      ));
    }
  } catch (err) {
    logger.warn({ err, circleId }, 'fanoutCircleChange: failed to fan out');
  }
}

// ─── Circle-event fanout (T13, 1 Nov 2026) ──────────────────────────────────
//
// An event now names a circle (made for it, or edited to it), or stopped naming it. Everyone in the circle
// hears it, as the circle is after the write: its ACTIVE members, the person who made it (who manages it with
// no member row), and the actor. Each recipient is sent, in an emit of their own:
//   circle:<id>                    the circle page, whose events list moved;
//   session:<id>                   the event page;
//   user:<recipient>:sessions      their own Home and Events lists.
// The bells' own tag (user:<id>:notifications) goes with each bell, from circle-events.service.ts.
// Modelled on resolveSessionListAudience + fanoutSessionListEntities: a recipient's tags name only themselves,
// so no client is told another member's id. A big circle is told in batches of CIRCLE_EVENT_FANOUT_BATCH.

export const CIRCLE_EVENT_FANOUT_BATCH = 200;

export async function resolveCircleEventAudience(circleId: string): Promise<string[]> {
  const { query } = await import('../db');
  const result = await query<{ user_id: string }>(
    `SELECT cm.user_id FROM circle_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.circle_id = $1 AND ${activeMemberSql('u')}
     UNION
     SELECT created_by FROM circles WHERE id = $1`,
    [circleId],
  );
  return result.rows.map(r => r.user_id);
}

export async function fanoutCircleEvent(circleId: string, sessionId: string, actorId?: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const recipients = [...new Set([...(await resolveCircleEventAudience(circleId)), actorId].filter(Boolean))] as string[];
    for (let i = 0; i < recipients.length; i += CIRCLE_EVENT_FANOUT_BATCH) {
      await Promise.all(recipients.slice(i, i + CIRCLE_EVENT_FANOUT_BATCH).map(userId =>
        emitEntities(io, [userId], [E.circle(circleId), E.session(sessionId), E.userSessions(userId)]),
      ));
    }
  } catch (err) {
    logger.warn({ err, circleId, sessionId }, 'fanoutCircleEvent: failed to fan out');
  }
}

// ─── The circles an entity is linked to (T15 review M2, 1 Nov 2026) ─────────
//
// A circle's page lists the entities linked to it with their name, kind and logo (circle_entities, migration 130). So
// when one of those changes (an edit, an archive, a new or removed logo or banner), the people of every circle the
// entity is linked to are told that circle's page changed, as its members are for any other change to it: each hears
// circle:<id> for the circles they are in (or made) only, in one emit of their own. One query reads every audience
// (at most 50 circles per entity, the same cap as the reads), and the emits go in batches of CIRCLE_EVENT_FANOUT_BATCH.
// A claim, an answer or a removal changes nothing a circle page shows, so those do not call this.

export const ENTITY_CIRCLES_MAX = 50;

export async function fanoutEntityCircles(entityId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const rows = await query<{ circle_id: string; user_id: string }>(
      `WITH linked AS (
         SELECT c.id, c.created_by FROM circle_entities ce JOIN circles c ON c.id = ce.circle_id
          WHERE ce.entity_id = $1 AND c.archived_at IS NULL
          ORDER BY c.id LIMIT ${ENTITY_CIRCLES_MAX})
       SELECT l.id AS circle_id, cm.user_id FROM linked l
         JOIN circle_members cm ON cm.circle_id = l.id JOIN users u ON u.id = cm.user_id
        WHERE ${activeMemberSql('u')}
       UNION
       SELECT l.id, l.created_by FROM linked l WHERE l.created_by IS NOT NULL`,
      [entityId],
    );
    const circlesOf = new Map<string, Set<string>>();
    for (const r of rows.rows) {
      const mine = circlesOf.get(r.user_id) ?? new Set<string>();
      mine.add(E.circle(r.circle_id));
      circlesOf.set(r.user_id, mine);
    }
    const recipients = [...circlesOf.entries()];
    for (let i = 0; i < recipients.length; i += CIRCLE_EVENT_FANOUT_BATCH) {
      await Promise.all(recipients.slice(i, i + CIRCLE_EVENT_FANOUT_BATCH).map(([userId, tags]) =>
        emitEntities(io, [userId], [...tags]),
      ));
    }
  } catch (err) {
    logger.warn({ err, entityId }, 'fanoutEntityCircles: failed to fan out');
  }
}

// ─── Profile-change fanout ──────────────────────────────────────────────────
//
// A member's public card changed without the profile form: creating or joining their company as its
// founder or an employee fills an empty profile company (21 Oct 2026). Same audience as a saved
// profile (PUT /users/me): the member's own user:<id>, and each pod they are an active member of,
// whose member lists show the card.

export async function fanoutProfileChange(userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const pods = await query<{ pod_id: string }>(
      `SELECT pod_id FROM pod_members WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    await Promise.all([fanoutUserEntity(userId), ...pods.rows.map(r => fanoutPodEntities(r.pod_id))]);
  } catch (err) {
    logger.warn({ err, userId }, 'fanoutProfileChange: failed to fan out');
  }
}

// ─── DM-conversation fanout ─────────────────────────────────────────────────
//
// Emits the dm-conversation entity to BOTH participants in the conversation.
// Used by REST read-receipt + reaction routes that mirror the socket-side
// dm-handlers fanout.

export async function fanoutDmConversation(
  conversationId: string,
  userIds: string[],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, userIds, [E.dmConversation(conversationId)]);
  } catch (err) {
    logger.warn({ err, conversationId }, 'fanoutDmConversation: failed to fan out');
  }
}

/**
 * A conversation was read over REST (POST /dm/conversations/:id/read): the same tags as the socket's dm:read
 * (handleDmRead), so the reader's other tabs and the writer's thread move too: the conversation (its read marks) and
 * each one's Messages (the inbox and the unread counts, which the Messages badge and the tab's "(N) REASON" read). Until
 * 1 Nov 2026 this path sent only the conversation's tag, and another tab of the reader kept its count.
 */
export async function fanoutDmRead(conversationId: string, readerId: string, otherId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, [readerId, otherId], [E.dmConversation(conversationId), E.userDms(readerId), E.userDms(otherId)]);
  } catch (err) {
    logger.warn({ err, conversationId }, 'fanoutDmRead: failed to fan out');
  }
}

// ─── Group chat fanout (26 Oct 2026) ────────────────────────────────────────
//
// A group chat changed: it was started, a message was sent, people were added, someone left or was
// removed (and maybe a new admin took over). Each member as they are after the change is sent, in an emit
// of their own, the group's tag (dm-group:<id>: its thread, details and members) and their own Messages
// tag (user:<id>:dms: the list and its unread counts). `alsoTell` names the people the change took out of
// the group, who are no longer members but whose Messages must drop it. Until 26 Oct this sent an untyped
// `group:<id>` that no query listened for.

export async function fanoutGroupEntities(
  groupId: string,
  alsoTell: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_group_members WHERE group_id = $1`,
      [groupId],
    );
    const recipients = new Set([...result.rows.map(r => r.user_id), ...alsoTell].filter(Boolean));
    await Promise.all([...recipients].map(userId =>
      emitEntities(io, [userId], [E.dmGroup(groupId), E.userDms(userId)]),
    ));
  } catch (err) {
    logger.warn({ err, groupId }, 'fanoutGroupEntities: failed to fan out');
  }
}

/**
 * A member's own read mark moves only their Messages list (the unread counts: user:<id>:dms), on every tab they
 * have open. It no longer sends the group's own tag back to the reader (H2b item 22, 26 Oct 2026): the reader
 * then read the group again for a mark they had just made, about six reads for every message that arrived, and a
 * busy group ran into the read limit and stopped updating. Nobody else learns of a read mark.
 */
export async function fanoutGroupReadMark(userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, [userId], [E.userDms(userId)]);
  } catch (err) {
    logger.warn({ err, userId }, 'fanoutGroupReadMark: failed to fan out');
  }
}

// ─── Permissions + roster (the two surviving bespoke events) ────────────────
//
// Phase 5 preserves `permissions:updated` and `roster:changed` because
// useSessionSocket subscribes to them to hydrate Zustand state (cohorts,
// actingAsHostOverrides, hostMutedUserIds, hostVisibilityModes) via the
// snapshot. The entity-tag handler can invalidate React-Query caches but
// cannot push into Zustand, so these two events stay.
//
// This helper bundles three things in lockstep:
//   1. the per-user `permissions:updated` emit (snapshot refetch for the
//      affected user's own tabs/devices),
//   2. the room-wide `roster:changed` emit (every viewer in the session
//      room rehydrates its snapshot),
//   3. the entity-tag emits — `session` + `sessionParticipants` for every
//      active participant, plus `user:${userId}` for the affected user
//      specifically.
// All three were previously bundled into the deleted `notifyPermissionsUpdated`
// wrapper.

export async function emitPermissionsUpdated(
  sessionId: string,
  userId: string,
  cause: string = 'acting_as_host_changed',
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  const { userRoom, sessionRoom } = await import('../services/orchestration/state/session-state');

  // 1. Direct emit to the affected user — useSessionSocket listener
  //    refetches the session-state snapshot on this event.
  io.to(userRoom(userId)).emit('permissions:updated', { sessionId, userId, cause });
  // Entity tags piggyback: user + session + participants for that user.
  await emitEntities(
    io,
    [userId],
    [E.session(sessionId), E.sessionParticipants(sessionId), E.user(userId)],
  ).catch(() => {});

  // 2. Room-wide roster:changed — every viewer's useSessionSocket listener
  //    refetches the snapshot so cohorts/overrides/counts/hccParticipants
  //    stay consistent across all clients in the same tick.
  io.to(sessionRoom(sessionId)).emit('roster:changed', { sessionId, cause });

  // 3. Resolve the room audience (active session_participants) so the
  //    entity tags reach every client's React-Query cache too.
  try {
    const { query } = await import('../db');
    const rosterRows = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
        WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
      [sessionId],
    );
    await emitEntities(
      io,
      rosterRows.rows.map(r => r.user_id),
      [E.session(sessionId), E.sessionParticipants(sessionId)],
    ).catch(() => {});
  } catch {
    /* roster fanout is best-effort */
  }

  // 4. Bug F + I (15 May Ali) — keep the HCC dashboard in lockstep. Force-
  //    variant bypasses the 1s coalesce so back-to-back acting-as-host
  //    toggles don't defer the second emit.
  try {
    const { emitHostDashboardForce } = await import('../services/orchestration/handlers/matching-flow');
    await emitHostDashboardForce(io, sessionId);
  } catch {
    /* opportunistic refresh — non-fatal if the helper isn't ready */
  }
}
