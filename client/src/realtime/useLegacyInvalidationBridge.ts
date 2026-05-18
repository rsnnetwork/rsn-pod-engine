// ─── Legacy invalidation bridge ──────────────────────────────────────────────
//
// COMPREHENSIVE event-to-query invalidation. Stays in place until the
// entity-tag architecture migration (Phase 2-5) replaces every bespoke
// event with `entity:changed`. Until then, every server-side socket event
// that mutates state needs an entry here so refreshing-isn't-required
// works on every page in RSN, in-event and out-of-event.
//
// Bug 41 (19 May Ali) — "Raja Ali King refreshes many times to see real-
// time host controls / the actual matching state". Root cause: this
// bridge handled only 6 events out of ~40; role-change events
// (`permissions:updated`, `cohost:assigned`, `cohost:removed`,
// `host:transferred`) had no listener at the App root, so they never
// invalidated any cache. Now every state-mutating event has a listener,
// each mapped to its affected query-key scope. The cardinal rule: when
// in doubt, invalidate too much rather than too little — a stale render
// is a real bug, an extra refetch is at worst a few hundred ms.
//
// The bridge mounts once in App.tsx, on every authenticated page. No
// per-page listeners need to know about it.

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';

// ─── Scoped invalidation helpers ────────────────────────────────────────────

const POD_QUERY_KEYS = [
  'my-pods',
  'pod',
  'pod-detail',
  'pod-members',
  'pod-member-counts',
  'pod-pending-members',
  'pod-pending-invites',
  'pod-session-count',
  'pod-sessions',
  'pod-members-for-invite',
  'pod-invites',
] as const;

const SESSION_QUERY_KEYS = [
  'session',
  'session-detail',
  'session-participants',
  'session-participant-counts',
  'session-pending-invites',
  'session-cohost',
  'session-host-state',
  'my-sessions',
  'pod-sessions',
  'pod-session-count',
  'host-state',
  'host-dashboard',
  'event-plan',
  'unrated-partners',
  'matching-templates',
] as const;

const INVITE_QUERY_KEYS = [
  'received-invites',
  'my-invites',
  'pod-pending-invites',
  'session-pending-invites',
] as const;

const USER_QUERY_KEYS = [
  'user',
  'user-block-status',
  'blocked-users',
  'can-message',
  'notification-prefs',
  'encounters',
] as const;

const DM_QUERY_KEYS = [
  'dm-conversations',
  'dm-groups',
  'dm-messages',
  'dm-unread-count',
  'can-message',
] as const;

const ADMIN_QUERY_KEYS = [
  'admin-users',
  'admin-pods',
  'admin-sessions',
  'admin-violations',
  'admin-join-requests',
  'admin-join-requests-pending',
  'admin-support-tickets',
  'admin-stats',
  'admin-recent-matches',
  // admin-analytics-* prefix family
  'admin-analytics',
  'admin-analytics-overview',
  'admin-analytics-funnel',
  'admin-analytics-retention',
  'admin-analytics-engagement',
  'admin-analytics-revenue',
  'admin-analytics-events',
  'admin-analytics-users',
  'admin-analytics-connections',
] as const;

function invalidateAll(qc: QueryClient, keys: readonly string[]): void {
  for (const key of keys) qc.invalidateQueries({ queryKey: [key] });
}
function invalidatePodScope(qc: QueryClient): void {
  invalidateAll(qc, POD_QUERY_KEYS);
}
function invalidateSessionScope(qc: QueryClient): void {
  invalidateAll(qc, SESSION_QUERY_KEYS);
}
function invalidateInviteScope(qc: QueryClient): void {
  invalidateAll(qc, INVITE_QUERY_KEYS);
}
function invalidateUserScope(qc: QueryClient): void {
  invalidateAll(qc, USER_QUERY_KEYS);
}
function invalidateDmScope(qc: QueryClient): void {
  invalidateAll(qc, DM_QUERY_KEYS);
}
function invalidateAdminScope(qc: QueryClient, scope?: string): void {
  if (!scope) {
    invalidateAll(qc, ADMIN_QUERY_KEYS);
    return;
  }
  const target = scope.startsWith('admin-') ? scope : `admin-${scope}`;
  for (const key of ADMIN_QUERY_KEYS) {
    if (key === target || key.startsWith(`${target}-`)) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }
}

export function useLegacyInvalidationBridge(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    // ── Cache-invalidation listeners ───────────────────────────────────
    // Each handler is small + scoped. The list-handlers-then-detach
    // pattern at the bottom keeps cleanup straightforward.

    const notificationNewHandler = () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['received-invites'] });
    };

    const podMembershipHandler = () => {
      invalidatePodScope(qc);
      invalidateInviteScope(qc);
      invalidateUserScope(qc);
      invalidateDmScope(qc);
      invalidateAll(qc, ['notifications', 'my-support-tickets']);
      invalidateAdminScope(qc);
    };

    const sessionListHandler = () => {
      invalidateSessionScope(qc);
      invalidateInviteScope(qc);
      invalidateAdminScope(qc, 'admin-sessions');
    };

    // Bug 41 — role + permission events. These never had listeners on
    // the App root before, which is why Raja had to refresh to see
    // host controls after being promoted.
    const permissionsHandler = () => {
      invalidateSessionScope(qc);
      invalidatePodScope(qc);
      invalidateUserScope(qc);
    };

    const cohostHandler = () => {
      invalidateSessionScope(qc);
      invalidateAdminScope(qc, 'admin-sessions');
    };

    const hostTransferredHandler = () => {
      invalidateSessionScope(qc);
      invalidatePodScope(qc);
      invalidateAdminScope(qc, 'admin-sessions');
    };

    // Session lifecycle + round events. Touch the whole session scope
    // so the "Round N of M" headers, plan strip, host controls, recap-
    // related queries all stay live.
    const sessionLifecycleHandler = () => {
      invalidateSessionScope(qc);
      invalidateAll(qc, ['my-sessions', 'pod-sessions']);
    };

    // Event plan recomputes (covers Bug 22/27/28 + plan repair events).
    const planChangedHandler = () => {
      invalidateAll(qc, ['event-plan', 'session', 'session-detail', 'host-state', 'session-participants']);
    };

    // Roster mutations (covers Bug 21/68 — "no refresh anywhere"
    // umbrella event). Server still emits this for legacy clients;
    // covering it explicitly here is the belt-and-braces for any
    // surface the more-targeted events don't cover.
    const rosterChangedHandler = () => {
      invalidateSessionScope(qc);
      invalidatePodScope(qc);
    };

    // Visibility / pin / tile-demote / matching cancel — all tweak
    // session-level state that the host controls + lobby render. Also
    // hits event-plan because matching_cancelled flips the plan
    // strip's round chip from "Planned · N pair" to "Cancelled · N
    // not matched".
    const sessionMutationHandler = () => {
      invalidateAll(qc, ['session', 'session-detail', 'host-state', 'event-plan']);
    };

    // Match lifecycle — when a match starts / ends / partner connects /
    // partner disconnects, the host's round dashboard and the
    // participant's own host-state need to reflect it.
    const matchLifecycleHandler = () => {
      invalidateAll(qc, ['host-state', 'host-dashboard', 'session-participants']);
    };

    // Participant-list events. Match assignment, leave, join, removal
    // all flip participants — and the counts derived from them.
    const participantListHandler = () => {
      invalidateAll(qc, ['session-participants', 'session-participant-counts', 'host-state']);
    };

    // Rating window events — invalidate so the host can see who's
    // rated, and the user's own unrated-partners list updates.
    const ratingHandler = () => {
      invalidateAll(qc, ['unrated-partners', 'session-participants', 'host-state']);
    };

    // Direct-message events (already broadcast by the server's REST
    // layer thanks to Bug 30's fanout helpers; covering them here for
    // any tab not yet receiving the entity:changed migration).
    const dmHandler = () => {
      invalidateDmScope(qc);
      invalidateAll(qc, ['notifications']);
    };

    // Forward-looking stubs (typed events 19 May server fanout added).
    const userProfileChangedHandler = (data: { userId?: string } = {}) => {
      if (data.userId) qc.invalidateQueries({ queryKey: ['user', data.userId] });
      invalidateUserScope(qc);
      invalidateDmScope(qc);
    };
    const adminListChangedHandler = (data: { scope?: string } = {}) => {
      invalidateAdminScope(qc, data.scope);
    };
    const notificationListChangedHandler = () => {
      invalidateAll(qc, ['notifications', 'received-invites', 'my-invites']);
    };
    const userBlocksChangedHandler = () => {
      invalidateUserScope(qc);
      invalidateDmScope(qc);
    };
    const userChangedHandler = (data: { userId?: string } = {}) => {
      if (data.userId) qc.invalidateQueries({ queryKey: ['user', data.userId] });
      invalidateUserScope(qc);
    };
    const groupChangedHandler = () => {
      invalidateDmScope(qc);
    };

    // ── Subscribe ──────────────────────────────────────────────────────

    socket.on('notification:new', notificationNewHandler);
    socket.on('pod:membership_updated', podMembershipHandler);
    socket.on('session:list_changed', sessionListHandler);

    // Bug 41 — role / permissions / cohost events were the actual gap.
    socket.on('permissions:updated', permissionsHandler);
    socket.on('cohost:assigned', cohostHandler);
    socket.on('cohost:removed', cohostHandler);
    socket.on('host:transferred', hostTransferredHandler);

    // Session lifecycle + rounds.
    socket.on('session:status_changed', sessionLifecycleHandler);
    socket.on('session:round_started', sessionLifecycleHandler);
    socket.on('session:round_ended', sessionLifecycleHandler);
    socket.on('session:completed', sessionLifecycleHandler);

    // Event plan + matching state.
    socket.on('host:event_plan_generated', planChangedHandler);
    socket.on('host:event_plan_repaired', planChangedHandler);
    socket.on('session:matching_preparing', sessionMutationHandler);
    socket.on('session:matching_cancelled', sessionMutationHandler);
    socket.on('session:matches_confirmed', sessionMutationHandler);

    // Roster + session-level state mutations.
    socket.on('roster:changed', rosterChangedHandler);
    socket.on('pin:changed', sessionMutationHandler);
    socket.on('tile:size_changed', sessionMutationHandler);
    socket.on('host:visibility_changed', sessionMutationHandler);
    socket.on('host:participant_removed', participantListHandler);

    // Match lifecycle.
    socket.on('match:assigned', matchLifecycleHandler);
    socket.on('match:reassigned', matchLifecycleHandler);
    socket.on('match:partner_disconnected', matchLifecycleHandler);
    socket.on('match:partner_reconnected', matchLifecycleHandler);
    socket.on('match:bye_round', matchLifecycleHandler);

    // Participant join/leave/count.
    socket.on('participant:joined', participantListHandler);
    socket.on('participant:left', participantListHandler);

    // Rating window.
    socket.on('rating:window_open', ratingHandler);
    socket.on('rating:window_closed', ratingHandler);

    // DM events.
    socket.on('dm:message', dmHandler);
    socket.on('dm:conversation_updated', dmHandler);
    socket.on('dm:read_receipt', dmHandler);
    socket.on('dm:reaction_added', dmHandler);
    socket.on('dm:reaction_removed', dmHandler);

    // User profile / admin / notifications / blocks / groups (typed).
    socket.on('user:changed', userChangedHandler);
    socket.on('user:blocks_changed', userBlocksChangedHandler);
    socket.on('admin:list_changed', adminListChangedHandler);
    socket.on('notification:list_changed', notificationListChangedHandler);
    socket.on('group:changed', groupChangedHandler);

    // Forward-looking stub (not yet emitted; harmless until then).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const untypedSocket = socket as any;
    untypedSocket.on('user:profile_changed', userProfileChangedHandler);

    return () => {
      socket.off('notification:new', notificationNewHandler);
      socket.off('pod:membership_updated', podMembershipHandler);
      socket.off('session:list_changed', sessionListHandler);
      socket.off('permissions:updated', permissionsHandler);
      socket.off('cohost:assigned', cohostHandler);
      socket.off('cohost:removed', cohostHandler);
      socket.off('host:transferred', hostTransferredHandler);
      socket.off('session:status_changed', sessionLifecycleHandler);
      socket.off('session:round_started', sessionLifecycleHandler);
      socket.off('session:round_ended', sessionLifecycleHandler);
      socket.off('session:completed', sessionLifecycleHandler);
      socket.off('host:event_plan_generated', planChangedHandler);
      socket.off('host:event_plan_repaired', planChangedHandler);
      socket.off('session:matching_preparing', sessionMutationHandler);
      socket.off('session:matching_cancelled', sessionMutationHandler);
      socket.off('session:matches_confirmed', sessionMutationHandler);
      socket.off('roster:changed', rosterChangedHandler);
      socket.off('pin:changed', sessionMutationHandler);
      socket.off('tile:size_changed', sessionMutationHandler);
      socket.off('host:visibility_changed', sessionMutationHandler);
      socket.off('host:participant_removed', participantListHandler);
      socket.off('match:assigned', matchLifecycleHandler);
      socket.off('match:reassigned', matchLifecycleHandler);
      socket.off('match:partner_disconnected', matchLifecycleHandler);
      socket.off('match:partner_reconnected', matchLifecycleHandler);
      socket.off('match:bye_round', matchLifecycleHandler);
      socket.off('participant:joined', participantListHandler);
      socket.off('participant:left', participantListHandler);
      socket.off('rating:window_open', ratingHandler);
      socket.off('rating:window_closed', ratingHandler);
      socket.off('dm:message', dmHandler);
      socket.off('dm:conversation_updated', dmHandler);
      socket.off('dm:read_receipt', dmHandler);
      socket.off('dm:reaction_added', dmHandler);
      socket.off('dm:reaction_removed', dmHandler);
      socket.off('user:changed', userChangedHandler);
      socket.off('user:blocks_changed', userBlocksChangedHandler);
      socket.off('admin:list_changed', adminListChangedHandler);
      socket.off('notification:list_changed', notificationListChangedHandler);
      socket.off('group:changed', groupChangedHandler);
      untypedSocket.off('user:profile_changed', userProfileChangedHandler);
    };
  }, [qc]);
}
