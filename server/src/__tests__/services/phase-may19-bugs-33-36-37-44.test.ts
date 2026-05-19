// Phase May-19 server-state correctness + signaling fixes.
//
// Pin tests for the post-realtime-migration batch (Bugs 33 / 36 / 37 / 44).
// Each `it` block names the bug + the concrete invariant it locks in, so a
// future refactor that drops the fix surfaces here as a red test in the
// same commit it broke.
//
// All assertions are source-grep based (same idiom as
// phase-may19-realtime-migration-phase2.test.ts). The handler bodies
// already have unit-level coverage; this file is the regression net for
// the BEHAVIOUR contract — "this call is in this branch on this path".

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs
    .readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8')
    .replace(/\r\n/g, '\n');
}

// Slice the source from `start` to the next `end` anchor (or +length chars).
function slice(src: string, start: string, end?: string, fallbackLen = 6000): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  if (!end) return src.slice(i, i + fallbackLen);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j > -1 ? j : i + fallbackLen);
}

describe('Phase May-19 — Bugs 33 / 36 / 37 / 44', () => {
  const hostActionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
  const participantFlowSrc = readServer('services/orchestration/handlers/participant-flow.ts');
  const hostParticipantsViewSrc = readServer('services/orchestration/handlers/host-participants-view.ts');
  const sessionServiceSrc = readServer('services/session/session.service.ts');

  // ── Bug 33 — Cohost promote/demote/transfer must recompute event plan ─

  describe('Bug 33 — cohost mutations call maybeRepairFutureRounds', () => {
    it('handleAssignCohost slice calls maybeRepairFutureRounds(io, sessionId)', () => {
      const fn = slice(hostActionsSrc, 'export async function handleAssignCohost',
        'export async function handleRemoveCohost');
      expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*sessionId\)/);
    });

    it('handleRemoveCohost slice calls maybeRepairFutureRounds(io, sessionId)', () => {
      const fn = slice(hostActionsSrc, 'export async function handleRemoveCohost',
        'export async function handlePromoteCohost');
      expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*sessionId\)/);
    });

    it('handlePromoteCohost slice calls maybeRepairFutureRounds(io, sessionId)', () => {
      const fn = slice(hostActionsSrc, 'export async function handlePromoteCohost',
        'export async function');
      expect(fn).toMatch(/maybeRepairFutureRounds\(io,\s*sessionId\)/);
    });

    it('maybeRepairFutureRounds in host-actions emits host:event_plan_repaired AND session+plan entities', () => {
      // Locked already by phase-may19-realtime-migration-phase2; this is
      // belt-and-braces — the helper that the three handlers above call
      // must itself produce the fanout.
      const fn = slice(hostActionsSrc, 'async function maybeRepairFutureRounds',
        '// Phase 2 (19 May 2026) — helper used');
      expect(fn).toMatch(/host:event_plan_repaired/);
      expect(fn).toMatch(/emitSessionRoomEntities\([\s\S]{0,400}E\.session\(sessionId\)[\s\S]{0,80}E\.sessionPlan\(sessionId\)/);
    });
  });

  // ── Bug 36 — host/cohost never stuck in LEFT on their own event ──────

  describe('Bug 36 — host/cohost LEFT carve-out', () => {
    it('handleJoinSession defensive-reset block handles status="left" for hosts/cohosts', () => {
      const fn = slice(participantFlowSrc, 'export async function handleJoinSession',
        '// Notify others — include isHost flag');
      // Looks up host_user_id + session_cohosts for the rejoining user
      expect(fn).toMatch(/SELECT[\s\S]{0,400}host_user_id[\s\S]{0,400}session_cohosts/);
      // And resets via the state machine LEFT → IN_MAIN_ROOM
      expect(fn).toMatch(/transitionParticipant\([\s\S]{0,200}ParticipantState\.IN_MAIN_ROOM/);
      // Audit log line names Bug 36 for visibility
      expect(fn).toMatch(/Bug 36[\s\S]{0,200}LEFT[\s\S]{0,200}in_main_room/);
    });

    it('disconnect-timeout LEFT transition is guarded with a host/cohost skip', () => {
      // The 15-second disconnect callback in handleDisconnect transitions
      // to LEFT — must skip for the director or any cohost.
      const idx = participantFlowSrc.indexOf('Phase 2.7 (5 May spec §9, 6 May per Ali');
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 2500);
      expect(fn).toMatch(/Bug 36[\s\S]{0,200}host\/cohost/);
      expect(fn).toMatch(/session_cohosts[\s\S]{0,200}is_cohost/);
      expect(fn).toMatch(/if\s*\(\s*isHostOrCohostDc\s*\)/);
      // Inside the else branch the LEFT transition still happens for
      // regular participants
      expect(fn).toMatch(/else[\s\S]{0,300}transitionParticipant\([\s\S]{0,200}ParticipantState\.LEFT/);
    });

    it('stale-heartbeat LEFT transition is guarded with a host/cohost skip', () => {
      // Anchor on the export — the line-7 docstring also mentions
      // startHeartbeatStaleDetection so indexOf alone hits the wrong place.
      const idx = participantFlowSrc.indexOf('export function startHeartbeatStaleDetection');
      expect(idx).toBeGreaterThan(-1);
      const fn = participantFlowSrc.slice(idx, idx + 3500);
      expect(fn).toMatch(/Bug 36[\s\S]{0,300}host\/cohost/);
      expect(fn).toMatch(/if\s*\(\s*isHostOrCohostStale\s*\)/);
      expect(fn).toMatch(/else[\s\S]{0,300}transitionParticipant\([\s\S]{0,200}ParticipantState\.LEFT/);
    });
  });

  // ── Bug 37 — combined participant-state hygiene pass ──────────────────

  describe('Bug 37 — participant-state hygiene', () => {
    it('37.1: handleJoinSession does NOT auto-checkin when status === SCHEDULED', () => {
      const fn = slice(participantFlowSrc, 'export async function handleJoinSession',
        '// ── FIX A: Defensive status reset');
      // Branch guard names SCHEDULED explicitly
      expect(fn).toMatch(/SessionStatus\.SCHEDULED/);
      // Comment trail names Bug 37.1 so future readers see the intent
      expect(fn).toMatch(/Bug 37\.1/);
      // Inside the SCHEDULED branch we do NOT call updateParticipantStatus.
      // The shape we're after:
      //   } else if (effectiveStatus === SessionStatus.SCHEDULED) {
      //     // Pre-start: do NOT auto-checkin ...
      //   } else { ... CHECKED_IN ... }
      const schedIdx = fn.indexOf('SessionStatus.SCHEDULED');
      const elseIdx = fn.indexOf('} else {', schedIdx);
      expect(elseIdx).toBeGreaterThan(-1);
      const schedBranch = fn.slice(schedIdx, elseIdx);
      expect(schedBranch).not.toMatch(/updateParticipantStatus/);
    });

    it('37.2: host-participants-view UNIONs the director when not in session_participants', () => {
      // The synthesis branch must still exist in the SELECT — locks in
      // the director-always-shows-in-HCC invariant.
      expect(hostParticipantsViewSrc).toMatch(/s\.host_user_id\s+AS\s+user_id/);
      expect(hostParticipantsViewSrc).toMatch(/NOT\s+EXISTS\s*\([\s\S]{0,400}session_participants\s+sp2[\s\S]{0,200}sp2\.user_id\s*=\s*s\.host_user_id/);
    });

    it('37.3: getParticipantStatusCounts counts the director exactly once', () => {
      const fn = slice(sessionServiceSrc, 'export async function getParticipantStatusCounts',
        'export async function isSessionParticipant');
      // Bug 37.3 comment is the named anchor for the fix
      expect(fn).toMatch(/Bug 37\.3/);
      // The SELECT no longer filters out the host (`user_id != $2` removed
      // from the GROUP BY query)
      const groupByQuery = fn.slice(fn.indexOf('SELECT status,'), fn.indexOf('GROUP BY status') + 20);
      expect(groupByQuery).not.toMatch(/user_id\s*!=\s*\$2/);
      // Synthesis branch: when the host has no row, add IN_LOBBY +1
      expect(fn).toMatch(/Synthesize the director row when missing/);
      expect(fn).toMatch(/hostRow\.rows\.length\s*===\s*0/);
      expect(fn).toMatch(/counts\['in_lobby'\]\s*=[\s\S]{0,80}\+\s*1/);
      expect(fn).toMatch(/activeTotal\s*\+=\s*1/);
    });
  });

  // ── Bug 44 — Match People reads stale eligibleCount before round starts ─

  describe('Bug 44 — host dashboard fans on cohost mutations + host join', () => {
    it('handleAssignCohost slice calls _emitHostDashboardForce or _emitHostDashboard', () => {
      const fn = slice(hostActionsSrc, 'export async function handleAssignCohost',
        'export async function handleRemoveCohost');
      expect(fn).toMatch(/_emitHostDashboardForce\(sessionId\)|_emitHostDashboard\(sessionId\)/);
    });

    it('handleRemoveCohost slice calls _emitHostDashboardForce or _emitHostDashboard', () => {
      const fn = slice(hostActionsSrc, 'export async function handleRemoveCohost',
        'export async function handlePromoteCohost');
      expect(fn).toMatch(/_emitHostDashboardForce\(sessionId\)|_emitHostDashboard\(sessionId\)/);
    });

    it('handlePromoteCohost slice calls _emitHostDashboardForce or _emitHostDashboard', () => {
      const fn = slice(hostActionsSrc, 'export async function handlePromoteCohost',
        'export async function');
      expect(fn).toMatch(/_emitHostDashboardForce\(sessionId\)|_emitHostDashboard\(sessionId\)/);
    });

    it('emitPermissionsUpdated (acting-as-host toggle) calls emitHostDashboardForce', () => {
      // Phase 5: the legacy notifyPermissionsUpdated wrapper was deleted from
      // orchestration.service.ts and replaced by emitPermissionsUpdated in
      // server/src/realtime/fanout.ts. The HCC force-refresh side-effect
      // must survive the relocation.
      const fanoutSrc = readServer('realtime/fanout.ts');
      const fn = slice(fanoutSrc, 'export async function emitPermissionsUpdated');
      expect(fn).toMatch(/emitHostDashboardForce\(io,\s*sessionId\)/);
    });

    it('handleJoinSession emits host dashboard for host on EVERY session state, not just ROUND_ACTIVE', () => {
      const fn = slice(participantFlowSrc, 'export async function handleJoinSession',
        'export async function handleLeaveSession');
      // Bug 44 named comment is the anchor
      expect(fn).toMatch(/Bug 44/);
      // Branch on the non-ROUND_ACTIVE case — must call emitHostDashboard
      const bug44Idx = fn.indexOf('Bug 44');
      expect(bug44Idx).toBeGreaterThan(-1);
      const bug44Slice = fn.slice(bug44Idx, bug44Idx + 1200);
      expect(bug44Slice).toMatch(/activeSession\.status\s*!==\s*SessionStatus\.ROUND_ACTIVE/);
      expect(bug44Slice).toMatch(/emitHostDashboard\(data\.sessionId\)/);
    });
  });
});
