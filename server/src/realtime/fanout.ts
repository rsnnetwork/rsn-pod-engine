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
import { emitEntities, getRealtimeIo } from './emit';
import { E } from './entities';

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
// session participant OR a member of the pod the session lives under. Emits
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
           AND status NOT IN ('removed', 'declined')`,
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
// Audience: the event's participants, its pod's members and its host. The host
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
       WHERE id = $1 AND host_user_id IS NOT NULL`,
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
// left it. Audience: its people as they are after the write (an archive keeps them), the member who
// acted, and each member whose link changed (one who has just left is no longer among its people).
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
    const people = await query<{ user_id: string }>(
      `SELECT user_id FROM entity_members WHERE entity_id = $1`,
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

// One member marked a group read: only their own tabs and devices redraw its unread count.
export async function fanoutGroupForUser(groupId: string, userId: string): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    await emitEntities(io, [userId], [E.dmGroup(groupId), E.userDms(userId)]);
  } catch (err) {
    logger.warn({ err, groupId, userId }, 'fanoutGroupForUser: failed to fan out');
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
