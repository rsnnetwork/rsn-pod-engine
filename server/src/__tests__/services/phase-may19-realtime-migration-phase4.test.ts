// Realtime architecture migration — Phase 4 page-level listener prune guard.
//
// Phase 4's mandate: in any per-page socket-listener file, REMOVE listeners
// that exist only to refetch / invalidate React Query caches (the global
// entity-tag handler now covers those via meta.entities). KEEP listeners
// that do non-cache work: Zustand state mutation, navigation, toast,
// timer/audio.
//
// Findings of the Phase 4 audit:
//   - useSessionSocket.ts: every listener does Zustand mutation, navigation,
//     toast, or timer work. NO listener is purely queryClient.invalidate*().
//     The hook does not even import useQueryClient — the cache layer is
//     handled exclusively by useLegacyInvalidationBridge.ts (which Phase 5
//     deletes).
//   - NotificationBell.tsx: two listeners (notification:new and
//     pod:membership_updated) — both refresh the bell's LOCAL component
//     state (useState notifications + unreadCount), not React Query cache.
//     Per Phase 4 rules these are non-cache work and stay.
//
// Net Phase 4 code change: zero listeners pruned. This test pins that
// outcome so Phase 5 (which removes the legacy bridge and the bespoke
// event names from shared types) has an exact contract to land against.
//
// The cardinal pins:
//   - `pod:membership_updated` and `session:list_changed` MUST NOT appear
//     in useSessionSocket.ts. The page-level live-event hook has no
//     business invalidating cross-page caches — that lives in the bridge.
//   - The Zustand-coupled listeners (`roster:changed`,
//     `host:visibility_changed`, `permissions:updated`, plus the broader
//     in-event listeners — match:assigned, rating:window_*, chat:*,
//     pin:changed, tile:size_changed, cohost:*, participant:*,
//     session:state, session:matching_*, host:event_plan_*,
//     host:round_dashboard, host:room_status_update, host:transferred via
//     host:participant_removed eviction path) MUST stay subscribed.
//
// Source: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// §4 Phase 4 + acceptance criteria.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('Realtime migration Phase 4 — page-level listener prune', () => {
  const sessionSrc = readClient('hooks/useSessionSocket.ts');
  const bellSrc = readClient('components/ui/NotificationBell.tsx');
  const bridgePath = nodePath.join(
    __dirname,
    '../../../../client/src/realtime/useLegacyInvalidationBridge.ts',
  );

  // ── Pruned listeners — must NOT appear in useSessionSocket.ts ──────────
  //
  // These are pure cache-invalidation events. The entity-tag handler at
  // App root invalidates the right React Query caches via meta.entities;
  // the legacy bridge still covers them too until Phase 5 deletes it.
  // The per-page live-event hook never had any business listening for
  // them, and this test pins it stays that way.
  describe('Pruned in useSessionSocket.ts (cache-only events live in the bridge)', () => {
    it('does NOT subscribe to pod:membership_updated', () => {
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]pod:membership_updated['"]/);
    });

    it('does NOT subscribe to session:list_changed', () => {
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]session:list_changed['"]/);
    });

    it('does NOT import useQueryClient (no React Query cache layer in the hook)', () => {
      expect(sessionSrc).not.toMatch(/useQueryClient/);
      expect(sessionSrc).not.toMatch(/invalidateQueries/);
    });

    it('does NOT subscribe to admin or notification list events (those are bridge-only)', () => {
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]admin:list_changed['"]/);
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]notification:list_changed['"]/);
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]user:changed['"]/);
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]user:blocks_changed['"]/);
      expect(sessionSrc).not.toMatch(/socket\.on\(\s*['"]group:changed['"]/);
    });
  });

  // ── Kept listeners — must remain in useSessionSocket.ts ────────────────
  //
  // Each one does non-cache work. The comment after each pin documents
  // exactly what work the listener performs so a future reader knows why
  // it survived Phase 4.
  describe('Kept in useSessionSocket.ts (non-cache work — Zustand / navigation / toast / timer)', () => {
    // Zustand store mutation — addParticipant / removeParticipant.
    it('subscribes to participant:joined and participant:left', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]participant:joined['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]participant:left['"]/);
    });

    // Zustand bulk-hydrate via the snapshot — can't migrate to entity tags.
    it('subscribes to session:state (bulk Zustand hydrate, no React Query)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:state['"]/);
    });

    // Zustand cohost set writes — addCohost / removeCohost.
    it('subscribes to cohost:assigned and cohost:removed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]cohost:assigned['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]cohost:removed['"]/);
    });

    // Zustand hostVisibilityModes write — not covered by React Query.
    it('subscribes to host:visibility_changed (sets Zustand hostVisibilityModes)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:visibility_changed['"]/);
      // Pin that the handler actually calls the store setter.
      const after = sessionSrc.slice(sessionSrc.indexOf("socket.on('host:visibility_changed'"));
      expect(after).toMatch(/store\.setHostVisibility/);
    });

    // Zustand global pin write — setServerPinnedUserId.
    it('subscribes to pin:changed (sets Zustand serverPinnedUserId)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]pin:changed['"]/);
      const after = sessionSrc.slice(sessionSrc.indexOf("socket.on('pin:changed'"));
      expect(after).toMatch(/store\.setServerPinnedUserId/);
    });

    // Zustand tile-demote list write — setTileDemotedUserIds.
    it('subscribes to tile:size_changed (sets Zustand tileDemotedUserIds)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]tile:size_changed['"]/);
      const after = sessionSrc.slice(sessionSrc.indexOf("socket.on('tile:size_changed'"));
      expect(after).toMatch(/store\.setTileDemotedUserIds/);
    });

    // roster:changed: spec caveat — snapshot fetch hydrates Zustand
    // (cohorts, actingAsHostOverrides, hostMutedUserIds,
    // hostVisibilityModes), none of which the entity handler can touch.
    it('subscribes to roster:changed (snapshot fetch hydrates Zustand state)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]roster:changed['"]/);
      const after = sessionSrc.slice(sessionSrc.indexOf("socket.on('roster:changed'"));
      expect(after).toMatch(/fetchSessionStateSnapshot/);
    });

    // permissions:updated: snapshot fetch hydrates the cohorts Set + the
    // per-user effective role (computed from session_cohosts on every
    // fetch). The entity-tag handler invalidates React Query caches but
    // cannot push into Zustand.
    it('subscribes to permissions:updated (snapshot fetch hydrates Zustand)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]permissions:updated['"]/);
      const after = sessionSrc.slice(sessionSrc.indexOf("socket.on('permissions:updated'"));
      expect(after).toMatch(/fetchSessionStateSnapshot/);
    });

    // Zustand state machine — phase / connectionStatus / transitionStatus.
    it('subscribes to session:evicted', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:evicted['"]/);
    });

    // Big Zustand state machine + timer logic.
    it('subscribes to session:status_changed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:status_changed['"]/);
    });

    // Round-lifecycle: timer + phase + totalRounds Zustand writes.
    it('subscribes to session:round_started / session:round_ended / session:completed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:round_started['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:round_ended['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:completed['"]/);
    });

    // Matching overlay UI state machine (preparingMatches + matchingOverlay).
    it('subscribes to session:matching_preparing / _in_progress / _cancelled / matches_confirmed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:matching_preparing['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:matching_in_progress['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:matching_cancelled['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]session:matches_confirmed['"]/);
    });

    // Match assignment triggers phase/navigation transitions + LiveKit
    // token Zustand state — never just cache invalidation.
    it('subscribes to match:assigned and match:reassigned (navigation/phase change)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:assigned['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:reassigned['"]/);
    });

    // Match-lifecycle Zustand writes.
    it('subscribes to match:partner_disconnected / partner_reconnected / return_to_lobby / bye_round', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:partner_disconnected['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:partner_reconnected['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:return_to_lobby['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]match:bye_round['"]/);
    });

    // Rating-window UI state machine — phase + timer + match Zustand writes.
    it('subscribes to rating:window_open and rating:window_closed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]rating:window_open['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]rating:window_closed['"]/);
    });

    // Direct broadcast list append in Zustand.
    it('subscribes to host:broadcast', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:broadcast['"]/);
    });

    // Toast + Zustand setEventPlanSummary / setTotalRounds / setBonusRoundsAdded.
    it('subscribes to host:event_plan_generated and host:event_plan_repaired (toast + Zustand)', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:event_plan_generated['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:event_plan_repaired['"]/);
    });

    // Zustand lobby-token + host-mute-command writes.
    it('subscribes to lobby:token and lobby:mute_command', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]lobby:token['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]lobby:mute_command['"]/);
    });

    // Zustand error + phase=complete write (the user has been kicked).
    it('subscribes to host:participant_removed', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:participant_removed['"]/);
    });

    // Zustand match-preview write.
    it('subscribes to host:match_preview', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:match_preview['"]/);
    });

    // Zustand setRoundDashboard / updateRoomStatus — host-side live data.
    it('subscribes to host:round_dashboard and host:room_status_update', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:round_dashboard['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]host:room_status_update['"]/);
    });

    // Direct chat append/replace/reaction-merge into Zustand chatMessages.
    it('subscribes to chat:message / chat:history / chat:reaction_update', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]chat:message['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]chat:history['"]/);
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]chat:reaction_update['"]/);
    });

    // Clock-skew-safe Zustand timer reset.
    it('subscribes to timer:sync', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]timer:sync['"]/);
    });

    // Toast + Zustand error banner.
    it('subscribes to error', () => {
      expect(sessionSrc).toMatch(/socket\.on\(\s*['"]error['"]/);
    });
  });

  // ── NotificationBell — only local component state listeners ────────────
  //
  // The bell intentionally keeps two thin listeners: notification:new
  // (append to local useState list + bump unreadCount) and
  // pod:membership_updated (refetch the local notification list so newly
  // arrived approval/rejection notifications appear without waiting for
  // the 30s poll). NEITHER touches React Query. All React-Query cache
  // invalidation for these events lives in useLegacyInvalidationBridge.
  describe('NotificationBell.tsx — local-state-only listeners (no React Query)', () => {
    it('subscribes to notification:new (local list append + unread counter)', () => {
      expect(bellSrc).toMatch(/socket\.on\(\s*['"]notification:new['"]/);
    });

    it('subscribes to pod:membership_updated (local notification list refetch only)', () => {
      expect(bellSrc).toMatch(/socket\.on\(\s*['"]pod:membership_updated['"]/);
      // Pin that the handler is fetchNotifications, NOT a qc.invalidate call.
      const after = bellSrc.slice(bellSrc.indexOf("socket.on('pod:membership_updated'"));
      expect(after).toMatch(/fetchNotifications/);
    });

    it('does NOT contain a hard-coded list of React Query keys to invalidate (that work is in the legacy bridge)', () => {
      // The bell holds invalidateInviteCaches for explicit invite-accept /
      // invite-decline mutations only — those are user-triggered REST
      // calls, not server-pushed cache fanouts. The audit confirms the
      // bell no longer reacts to socket events with qc.invalidateQueries.
      // Grep the file for any socket.on('...') block that contains qc.invalidate.
      const onBlocks = bellSrc.match(/socket\.on\(\s*['"][^'"]+['"][\s\S]{0,400}?\}/g) || [];
      for (const block of onBlocks) {
        expect(block).not.toMatch(/qc\.invalidateQueries/);
      }
    });
  });

  // ── Legacy bridge — deleted by Phase 5 ─────────────────────────────────
  //
  // Phase 4 kept the bridge intact as the cache-invalidation safety net.
  // Phase 5 deletes it: every React Query now declares meta.entities and
  // the entity-tag handler at the App root invalidates everything via
  // the server's emitEntities() fanout. The bridge is obsolete.
  describe('Legacy bridge — deleted by Phase 5', () => {
    it('useLegacyInvalidationBridge.ts no longer exists', () => {
      expect(nodeFs.existsSync(bridgePath)).toBe(false);
    });
  });
});
