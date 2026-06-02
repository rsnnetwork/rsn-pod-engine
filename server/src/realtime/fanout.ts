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

// ─── Group fanout ───────────────────────────────────────────────────────────
//
// Emits the group:${groupId} entity to every dm_group_members row so each
// member's inbox + thread surfaces refetch.

export async function fanoutGroupEntities(
  groupId: string,
  extraEntities: string[] = [],
): Promise<void> {
  const io = getRealtimeIo();
  if (!io) return;
  try {
    const { query } = await import('../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_group_members WHERE group_id = $1`,
      [groupId],
    );
    await emitEntities(
      io,
      result.rows.map(r => r.user_id),
      [`group:${groupId}`, ...extraEntities],
    );
  } catch (err) {
    logger.warn({ err, groupId }, 'fanoutGroupEntities: failed to fan out');
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
