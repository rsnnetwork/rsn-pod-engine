// Realtime architecture migration — Phase 2 dual-emit regression guard.
//
// For every legacy fanout helper / in-handler broadcast covered by the
// Phase 2 spec, this file pins TWO assertions:
//   1. the legacy emit ('pod:membership_updated', 'roster:changed', etc.)
//      still fires (we don't remove it until Phase 5)
//   2. an emitEntities() call with the matching domain-entity tags fires
//      alongside it in the same function body
//
// The two assertions are scoped to the same `slice()` of source so a
// future refactor that moves the new emit to a different function — or
// drops it entirely — fails this test immediately.
//
// Source: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
// Mapping: §4 (entity vocabulary table) + the user-supplied Phase 2 table.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('Realtime migration Phase 2 — dual-emit', () => {
  const orchSrc = readServer('services/orchestration/orchestration.service.ts');
  const hostActionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
  const participantFlowSrc = readServer('services/orchestration/handlers/participant-flow.ts');
  const roundLifecycleSrc = readServer('services/orchestration/handlers/round-lifecycle.ts');
  const matchingFlowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
  const dmHandlersSrc = readServer('services/orchestration/handlers/dm-handlers.ts');
  const pokeSrc = readServer('services/poke/poke.service.ts');
  const inviteSrc = readServer('services/invite/invite.service.ts');

  // Helper — slice the file from the start of a function (or anchor) to the
  // next anchor / EOF, so dual-emit assertions are bounded to that function.
  function slice(src: string, start: string, end?: string): string {
    const i = src.indexOf(start);
    expect(i).toBeGreaterThan(-1);
    if (!end) return src.slice(i, i + 4000);
    const j = src.indexOf(end, i + start.length);
    return src.slice(i, j > -1 ? j : i + 8000);
  }

  // ── orchestration.service.ts notify* helpers ───────────────────────────

  describe('orchestration.service.ts — notify* dual-emit', () => {
    it('imports emitEntities and E from the realtime module', () => {
      expect(orchSrc).toMatch(/from\s*['"]\.\.\/\.\.\/realtime\/emit['"]/);
      expect(orchSrc).toMatch(/from\s*['"]\.\.\/\.\.\/realtime\/entities['"]/);
      expect(orchSrc).toMatch(/import\s*\{\s*emitEntities\s*\}/);
      expect(orchSrc).toMatch(/import\s*\{\s*E\s*\}/);
    });

    it('notifyPodChanged still emits pod:membership_updated AND emitEntities pod+members+invites', () => {
      const fn = slice(orchSrc, 'export async function notifyPodChanged',
        'export async function notifySessionListChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(row\.user_id\)\)\.emit\(\s*['"]pod:membership_updated['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,200}E\.pod\(podId\)/);
      expect(fn).toMatch(/E\.podMembers\(podId\)/);
      expect(fn).toMatch(/E\.podInvites\(podId\)/);
      expect(fn).toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    });

    it('notifySessionListChanged still emits session:list_changed AND emitEntities session+participants(+podSessions)', () => {
      const fn = slice(orchSrc, 'export async function notifySessionListChanged',
        'export async function notifyPermissionsUpdated');
      expect(fn).toMatch(/io\.to\(userRoom\(row\.user_id\)\)\.emit\(\s*['"]session:list_changed['"]/);
      // Pass-by-array `[E.session(sessionId), E.sessionParticipants(sessionId)]`
      // followed by a conditional push of `E.podSessions(podId)`.
      expect(fn).toMatch(/E\.session\(sessionId\)/);
      expect(fn).toMatch(/E\.sessionParticipants\(sessionId\)/);
      expect(fn).toMatch(/E\.podSessions\(podId\)/);
      expect(fn).toMatch(/emitEntities\(io,/);
    });

    it('notifyPermissionsUpdated still emits permissions:updated AND roster:changed AND emitEntities session+participants+user', () => {
      const fn = slice(orchSrc, 'export async function notifyPermissionsUpdated',
        '// ── Phase May-19 realtime gap closures');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]permissions:updated['"]/);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]roster:changed['"]/);
      // Targeted single-user dual-emit
      expect(fn).toMatch(/emitEntities\(\s*\n?\s*io,\s*\n?\s*\[userId\][\s\S]{0,200}E\.user\(userId\)/);
      // Roster-room dual-emit (session + participants for every viewer)
      expect(fn).toMatch(/emitEntities\([\s\S]{0,300}E\.sessionParticipants\(sessionId\)/);
    });

    it('notifyAdminListChanged still emits admin:list_changed AND emitEntities `admin:${scope}`', () => {
      const fn = slice(orchSrc, 'export async function notifyAdminListChanged',
        'export async function notifyOwnNotificationsChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(row\.id\)\)\.emit\(\s*['"]admin:list_changed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,200}`admin:\$\{scope\}`/);
    });

    it('notifyOwnNotificationsChanged still emits notification:list_changed AND emitEntities userNotifications', () => {
      const fn = slice(orchSrc, 'export async function notifyOwnNotificationsChanged',
        'export async function notifyUserBlocksChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]notification:list_changed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,200}E\.userNotifications\(userId\)/);
    });

    it('notifyUserBlocksChanged still emits user:blocks_changed AND emitEntities userBlocks for both', () => {
      const fn = slice(orchSrc, 'export async function notifyUserBlocksChanged',
        'export async function notifyUserChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(blockerId\)\)\.emit\(\s*['"]user:blocks_changed['"]/);
      expect(fn).toMatch(/io\.to\(userRoom\(blockedId\)\)\.emit\(\s*['"]user:blocks_changed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,300}E\.userBlocks\(blockerId\)[\s\S]{0,200}E\.userBlocks\(blockedId\)/);
    });

    it('notifyUserChanged still emits user:changed AND emitEntities E.user(userId)', () => {
      const fn = slice(orchSrc, 'export async function notifyUserChanged',
        'export async function notifyDmReactionChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]user:changed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,200}E\.user\(userId\)/);
    });

    it('notifyDmReactionChanged still emits dm:reaction_(added|removed) AND emitEntities dmConversation', () => {
      const fn = slice(orchSrc, 'export async function notifyDmReactionChanged',
        'export async function notifyDmReadReceipt');
      expect(fn).toMatch(/added \? 'dm:reaction_added' : 'dm:reaction_removed'/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,300}E\.dmConversation\(conversationId\)/);
    });

    it('notifyDmReadReceipt still emits dm:read_receipt AND emitEntities dmConversation', () => {
      const fn = slice(orchSrc, 'export async function notifyDmReadReceipt',
        'export async function notifyGroupChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(readerId\)\)\.emit\(\s*['"]dm:read_receipt['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,300}E\.dmConversation\(conversationId\)/);
    });

    it('notifyGroupChanged still emits group:changed AND emitEntities `group:${groupId}`', () => {
      const fn = slice(orchSrc, 'export async function notifyGroupChanged',
        '// ── Get Active Session State');
      expect(fn).toMatch(/io\.to\(userRoom\(row\.user_id\)\)\.emit\(\s*['"]group:changed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,200}`group:\$\{groupId\}`/);
    });

    it('notifyPodMembershipChanged (single-user variant) dual-emits pod+members+userPods', () => {
      const fn = slice(orchSrc, 'export async function notifyPodMembershipChanged',
        'export async function notifyPodChanged');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]pod:membership_updated['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,300}E\.pod\(podId\)[\s\S]{0,200}E\.podMembers\(podId\)[\s\S]{0,200}E\.userPods\(userId\)/);
    });
  });

  // ── host-actions.ts in-handler dual-emit ───────────────────────────────

  describe('host-actions.ts — in-handler dual-emit', () => {
    it('imports emitEntities and E from realtime', () => {
      expect(hostActionsSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/emit['"]/);
      expect(hostActionsSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/entities['"]/);
    });

    it('defines an emitSessionRoomEntities helper that resolves the active participants', () => {
      expect(hostActionsSrc).toMatch(/async function emitSessionRoomEntities\(/);
      expect(hostActionsSrc).toMatch(/SELECT user_id FROM session_participants[\s\S]{0,200}status NOT IN/);
    });

    it('maybeRepairFutureRounds emits host:event_plan_repaired AND emitSessionRoomEntities session+plan', () => {
      const fn = slice(hostActionsSrc, 'async function maybeRepairFutureRounds',
        '// Phase 2 (19 May 2026) — helper used');
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]host:event_plan_repaired['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\([\s\S]{0,200}E\.session\(sessionId\)[\s\S]{0,80}E\.sessionPlan\(sessionId\)/);
    });

    it('handleHostStart emits host:event_plan_generated AND emitSessionRoomEntities session+plan', () => {
      // The event plan generated emit lives inside handleHostStart (see
      // the "Pre-event plan generated (Phase 2.5A)" block).
      const idx = hostActionsSrc.indexOf("'host:event_plan_generated'");
      expect(idx).toBeGreaterThan(-1);
      const fn = hostActionsSrc.slice(Math.max(0, idx - 400), idx + 1200);
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]host:event_plan_generated['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\([\s\S]{0,300}E\.sessionPlan\(data\.sessionId\)/);
    });

    it('handleHostRemoveParticipant emits roster:changed AND emitSessionRoomEntities session+participants', () => {
      const fn = slice(hostActionsSrc, 'export async function handleHostRemoveParticipant',
        'export async function handleHostReassign');
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]roster:changed['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\([\s\S]{0,300}E\.session\(data\.sessionId\)[\s\S]{0,80}E\.sessionParticipants\(data\.sessionId\)/);
    });

    it('handleHostReassign emits match:reassigned AND emitEntities session+participants+match', () => {
      const fn = slice(hostActionsSrc, 'export async function handleHostReassign',
        '// ─── Host: Mute/Unmute Participant');
      expect(fn).toMatch(/io\.to\(userRoom\(targetId\)\)\.emit\(\s*['"]match:reassigned['"]/);
      expect(fn).toMatch(/io\.to\(userRoom\(partner\)\)\.emit\(\s*['"]match:reassigned['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(matchId\)/);
    });

    it('handlePromoteCohost (T1-5) emits host:transferred AND dual-emits session+participants', () => {
      const idx = hostActionsSrc.indexOf('export async function handlePromoteCohost');
      expect(idx).toBeGreaterThan(-1);
      const fn = hostActionsSrc.slice(idx, idx + 4000);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]host:transferred['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\(io,\s*sessionId,/);
      expect(fn).toMatch(/E\.sessionParticipants\(sessionId\)/);
      expect(fn).toMatch(/emitEntities\(io,\s*\[hostId,\s*cohostUserId\]/);
    });

    it('setHostVisibility emits host:visibility_changed AND emitSessionRoomEntities session', () => {
      const fn = slice(hostActionsSrc, 'export async function setHostVisibility',
        'export async function startSession');
      expect(fn).toMatch(/_io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]host:visibility_changed['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\(_io,\s*sessionId,\s*\[\s*E\.session\(sessionId\)\s*\]/);
    });

    it('handleHostSetPin emits pin:changed AND emitSessionRoomEntities session', () => {
      const fn = slice(hostActionsSrc, 'export async function handleHostSetPin',
        '// Bug 26 (19 May Ali) — director can flatten');
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]pin:changed['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\(io,\s*sessionId,\s*\[\s*E\.session\(sessionId\)\s*\]/);
    });

    it('handleHostSetTileSize emits tile:size_changed AND emitSessionRoomEntities session', () => {
      const fn = slice(hostActionsSrc, 'export async function handleHostSetTileSize');
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]tile:size_changed['"]/);
      expect(fn).toMatch(/emitSessionRoomEntities\(io,\s*sessionId,\s*\[\s*E\.session\(sessionId\)\s*\]/);
    });

    it('handleHostRemoveFromRoom emits match:partner_disconnected AND emitEntities for affected partners', () => {
      // The match:partner_disconnected emit lives inside handleHostRemoveFromRoom.
      const idx = hostActionsSrc.indexOf("'match:partner_disconnected', { matchId: data.matchId }");
      expect(idx).toBeGreaterThan(-1);
      const fn = hostActionsSrc.slice(Math.max(0, idx - 200), idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(partnerId\)\)\.emit\(\s*['"]match:partner_disconnected['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(data\.matchId\)/);
    });

    it('handleHostMoveToRoom (move flow) emits match:reassigned per-pid AND emitEntities for the new room', () => {
      const idx = hostActionsSrc.indexOf("'match:reassigned'", hostActionsSrc.indexOf('handleHostMoveToRoom'));
      expect(idx).toBeGreaterThan(-1);
      const fn = hostActionsSrc.slice(idx, idx + 2000);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(newMatchId\)/);
    });
  });

  // ── participant-flow.ts in-handler dual-emit ───────────────────────────

  describe('participant-flow.ts — in-handler dual-emit', () => {
    it('imports emitEntities and E from realtime', () => {
      expect(participantFlowSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/emit['"]/);
      expect(participantFlowSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/entities['"]/);
    });

    it('defines a fanSessionRoomEntities helper', () => {
      expect(participantFlowSrc).toMatch(/async function fanSessionRoomEntities\(/);
    });

    it('maybeRepairFutureRounds emits host:event_plan_repaired AND fanSessionRoomEntities session+plan', () => {
      // The function-level helper repairs future rounds; the emit lives in
      // its `runRepair` inner function which contains `emit('host:event_plan_repaired',`.
      const idx = participantFlowSrc.indexOf("'host:event_plan_repaired'");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(Math.max(0, idx - 200), idx + 2000);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]host:event_plan_repaired['"]/);
      expect(fn).toMatch(/fanSessionRoomEntities\([\s\S]{0,400}E\.sessionPlan\(sessionId\)/);
    });

    it('handleJoinSession emits participant:joined + roster:changed AND fanSessionRoomEntities', () => {
      const fn = slice(participantFlowSrc, 'export async function handleJoinSession',
        'export async function handleLeaveSession');
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]participant:joined['"]/);
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]roster:changed['"]/);
      expect(fn).toMatch(/fanSessionRoomEntities\([\s\S]{0,400}E\.sessionParticipants\(data\.sessionId\)/);
    });

    it('handleLeaveSession emits participant:left AND fanSessionRoomEntities + emitEntities for self', () => {
      const fn = slice(participantFlowSrc, 'export async function handleLeaveSession',
        '// ─── Heartbeat');
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]participant:left['"]/);
      expect(fn).toMatch(/fanSessionRoomEntities\([\s\S]{0,400}E\.sessionParticipants\(data\.sessionId\)/);
      expect(fn).toMatch(/emitEntities\(\s*\n?\s*io,\s*\[userId\][\s\S]{0,400}E\.sessionParticipants\(data\.sessionId\)/);
    });

    it('handleJoinSession (mid-round restore) emits match:assigned AND emitEntities session+participants+match', () => {
      const idx = participantFlowSrc.indexOf("socket.emit('match:assigned'");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/socket\.emit\(\s*['"]match:assigned['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(userMatch\.id\)/);
    });

    it('handleDisconnect emits participant:left AND fanSessionRoomEntities', () => {
      const idx = participantFlowSrc.indexOf("io.to(sessionRoom(sessionId)).emit('participant:left', { userId, isHost }");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 1200);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]participant:left['"]/);
      expect(fn).toMatch(/fanSessionRoomEntities\([\s\S]{0,400}E\.sessionParticipants\(sessionId\)/);
    });

    it('handleDisconnect (round-active) emits match:partner_disconnected AND emitEntities match', () => {
      // First partner-disconnected emit lives inside the round-active branch.
      const idx = participantFlowSrc.indexOf("'match:partner_disconnected', {");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(Math.max(0, idx - 300), idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(partnerId\)\)\.emit\(\s*['"]match:partner_disconnected['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(userMatch\.id\)/);
    });

    it('handleDisconnect (auto-reassign) emits match:reassigned AND emitEntities match', () => {
      // The auto-reassign block under the disconnect timeout.
      const idx = participantFlowSrc.lastIndexOf("io.to(userRoom(partnerId)).emit('match:reassigned'");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(candidateUserId\)\)\.emit\(\s*['"]match:reassigned['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(matchId\)/);
    });

    it('disconnect-reconnect-window emits match:partner_reconnected AND emitEntities match', () => {
      const idx = participantFlowSrc.indexOf("'match:partner_reconnected'");
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(Math.max(0, idx - 300), idx + 1000);
      expect(fn).toMatch(/io\.to\(userRoom\(partnerId\)\)\.emit\(\s*['"]match:partner_reconnected['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(disconnectMatchId\)/);
    });

    it('stale-heartbeat sweep emits participant:left AND fanSessionRoomEntities', () => {
      // The actual function body starts at `export function startHeartbeatStaleDetection`.
      const idx = participantFlowSrc.indexOf('export function startHeartbeatStaleDetection');
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 3000);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]participant:left['"]/);
      expect(fn).toMatch(/fanSessionRoomEntities\([\s\S]{0,500}E\.sessionParticipants\(sessionId\)/);
    });
  });

  // ── round-lifecycle.ts in-handler dual-emit ────────────────────────────

  describe('round-lifecycle.ts — in-handler dual-emit', () => {
    it('imports emitEntities and E from realtime', () => {
      expect(roundLifecycleSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/emit['"]/);
      expect(roundLifecycleSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/entities['"]/);
    });

    it('transitionToRound emits match:assigned per-pid AND emitEntities session+participants+match', () => {
      const idx = roundLifecycleSrc.indexOf("io.to(userRoom(pid)).emit('match:assigned'");
      expect(idx).toBeGreaterThan(-1);
      const fn = roundLifecycleSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(pid\)\)\.emit\(\s*['"]match:assigned['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.match\(match\.id\)/);
    });

    it('endRound emits rating:window_open per-pid AND emitEntities session+participants', () => {
      const idx = roundLifecycleSrc.indexOf("io.to(userRoom(pid)).emit('rating:window_open'");
      expect(idx).toBeGreaterThan(-1);
      const fn = roundLifecycleSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(pid\)\)\.emit\(\s*['"]rating:window_open['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.sessionParticipants\(sessionId\)/);
    });

    it('endRatingWindow emits rating:window_closed AND emitEntities for the room audience', () => {
      const idx = roundLifecycleSrc.indexOf("'rating:window_closed'");
      expect(idx).toBeGreaterThan(-1);
      const fn = roundLifecycleSrc.slice(Math.max(0, idx - 200), idx + 1500);
      expect(fn).toMatch(/io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]rating:window_closed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.sessionParticipants\(sessionId\)/);
    });
  });

  // ── matching-flow.ts in-handler dual-emit ──────────────────────────────

  describe('matching-flow.ts — in-handler dual-emit', () => {
    it('imports emitEntities and E from realtime', () => {
      expect(matchingFlowSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/emit['"]/);
      expect(matchingFlowSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/entities['"]/);
    });

    it('bonus-round bump (host:event_plan_repaired) AND emitEntities session+plan', () => {
      const idx = matchingFlowSrc.indexOf("'host:event_plan_repaired'");
      expect(idx).toBeGreaterThan(-1);
      const fn = matchingFlowSrc.slice(Math.max(0, idx - 200), idx + 1500);
      expect(fn).toMatch(/io\.to\(sessionRoom\(data\.sessionId\)\)\.emit\(\s*['"]host:event_plan_repaired['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.sessionPlan\(data\.sessionId\)/);
    });
  });

  // ── dm-handlers.ts in-handler dual-emit ────────────────────────────────

  describe('dm-handlers.ts — in-handler dual-emit', () => {
    it('imports emitEntities and E from realtime', () => {
      expect(dmHandlersSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/emit['"]/);
      expect(dmHandlersSrc).toMatch(/from\s*['"]\.\.\/\.\.\/\.\.\/realtime\/entities['"]/);
    });

    it('broadcastDmMessage emits dm:message + dm:conversation_updated AND emitEntities dmConversation+userDms', () => {
      const fn = slice(dmHandlersSrc, 'async function broadcastDmMessage',
        '// ─── Handlers');
      expect(fn).toMatch(/io\.to\(userRoom\(fromUserId\)\)\.emit\(\s*['"]dm:message['"]/);
      expect(fn).toMatch(/io\.to\(userRoom\(toUserId\)\)\.emit\(\s*['"]dm:conversation_updated['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.dmConversation\(conversationId\)/);
      expect(fn).toMatch(/E\.userDms\(fromUserId\)/);
      expect(fn).toMatch(/E\.userDms\(toUserId\)/);
    });

    it('broadcastDmMessage (notification:new) AND emitEntities userNotifications + userInvites', () => {
      const idx = dmHandlersSrc.indexOf("io.to(userRoom(toUserId)).emit('notification:new'");
      expect(idx).toBeGreaterThan(-1);
      const fn = dmHandlersSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/io\.to\(userRoom\(toUserId\)\)\.emit\(\s*['"]notification:new['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.userNotifications\(toUserId\)/);
      expect(fn).toMatch(/E\.userInvites\(toUserId\)/);
    });

    it('handleDmReact emits dm:reaction_added AND emitEntities dmConversation', () => {
      const fn = slice(dmHandlersSrc, 'export async function handleDmReact',
        'export async function handleDmUnreact');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]dm:reaction_added['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.dmConversation\(conversationId\)/);
    });

    it('handleDmUnreact emits dm:reaction_removed AND emitEntities dmConversation', () => {
      const fn = slice(dmHandlersSrc, 'export async function handleDmUnreact',
        'export async function handleDmRead');
      expect(fn).toMatch(/io\.to\(userRoom\(userId\)\)\.emit\(\s*['"]dm:reaction_removed['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,400}E\.dmConversation\(conversationId\)/);
    });

    it('handleDmRead emits dm:read_receipt AND emitEntities dmConversation+userDms', () => {
      const fn = slice(dmHandlersSrc, 'export async function handleDmRead');
      expect(fn).toMatch(/io\.to\(userRoom\(otherUserId\)\)\.emit\(\s*['"]dm:read_receipt['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.dmConversation\(data\.conversationId\)/);
    });
  });

  // ── notification:new emit sites (single-recipient) ─────────────────────

  describe('notification:new emit sites dual-emit userNotifications+userInvites', () => {
    it('poke.service.ts notification:new emits emitEntities for the recipient', () => {
      const idx = pokeSrc.indexOf("io.to(`user:${recipientId}`).emit('notification:new'");
      expect(idx).toBeGreaterThan(-1);
      const fn = pokeSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/emit\(\s*['"]notification:new['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.userNotifications\(recipientId\)/);
      expect(fn).toMatch(/E\.userInvites\(recipientId\)/);
    });

    it('invite.service.ts notification:new emits emitEntities for the invitee', () => {
      const idx = inviteSrc.indexOf("emit('notification:new'");
      expect(idx).toBeGreaterThan(-1);
      const fn = inviteSrc.slice(idx, idx + 1500);
      expect(fn).toMatch(/emit\(\s*['"]notification:new['"]/);
      expect(fn).toMatch(/emitEntities\([\s\S]{0,500}E\.userNotifications\(inviteeId\)/);
      expect(fn).toMatch(/E\.userInvites\(inviteeId\)/);
    });
  });

  // ── catch-suffix safety ────────────────────────────────────────────────

  describe('every emitEntities call in the dual-emit set is `.catch()`-guarded', () => {
    // Across the whole orchestration tree, every emitEntities call we
    // added in Phase 2 should be either followed by `.catch(() => {})` OR
    // sit inside a `try`/`catch` block (or be `await`ed by a caller that
    // is itself guarded). A bare unhandled rejection from a fanout failure
    // would break the user-facing response.
    const files: Array<[string, string]> = [
      ['orchSrc', orchSrc],
      ['hostActionsSrc', hostActionsSrc],
      ['participantFlowSrc', participantFlowSrc],
      ['roundLifecycleSrc', roundLifecycleSrc],
      ['matchingFlowSrc', matchingFlowSrc],
      ['dmHandlersSrc', dmHandlersSrc],
      ['pokeSrc', pokeSrc],
      ['inviteSrc', inviteSrc],
    ];

    /** Strip line-comments and block-comments so we don't false-positive
     *  on `emitEntities(` mentions inside `//` or `/* * /` prose. */
    function stripComments(src: string): string {
      // Block comments first.
      let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
      // Line comments (after block comments are gone).
      s = s.replace(/^[ \t]*\/\/.*$/gm, '');
      // Trailing `// ...` on code lines too.
      s = s.replace(/[ \t]+\/\/.*$/gm, '');
      return s;
    }

    it('no Phase 2 emitEntities call body leaks an unhandled rejection', () => {
      for (const [name, raw] of files) {
        const src = stripComments(raw);
        // Match `emitEntities(...)` invocations (not `import { emitEntities }`,
        // not function declaration). We capture each call site PLUS a
        // tail window large enough to spot a `.catch(`, semicolon, or
        // the end-of-statement.
        const callRegex = /(?:^|[^a-zA-Z_.])(?:await\s+)?emitEntities\(/g;
        let m: RegExpExecArray | null;
        while ((m = callRegex.exec(src)) !== null) {
          const start = m.index;
          // Skip if the call is preceded by `await ` — caller handles errors.
          const before = src.slice(Math.max(0, start - 10), start + m[0].length);
          if (/await\s+emitEntities\($/.test(before)) continue;
          // Tail = next 400 chars (covers multi-line emitEntities(...) blocks
          // with their `.catch(...)`).
          const tail = src.slice(start, start + 600);
          expect({
            file: name,
            snippet: tail.slice(0, 200),
          }).toMatchObject({
            file: name,
            snippet: expect.stringMatching(/\.catch\(/),
          });
        }
      }
    });
  });
});
