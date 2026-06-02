// 23 May live-test host-control fixes (Stefan). Source-pattern pins for the
// behaviors added in branch fix/may23-live-test-host-fixes. See
// docs/superpowers/plans/2026-05-23-live-test-host-control-fixes.md.
//
// #2 (bump-on-start) is pinned by phase-may18-bug22-extra-round.test.ts,
// #3 (swap excludes both rooms) by match-validator(-wiring).test.ts, and
// #8 (PARTICIPANT_ALREADY_MATCHED + REMATCH_NO_ALTERNATIVE toasts) by
// phase-4-and-5-atomic-and-errors.test.ts. This file covers #1, #4, #5, #7.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('23 May live-test host-control fixes', () => {
  const flowSrc = readServer('services/orchestration/handlers/matching-flow.ts');
  const lifecycleSrc = readServer('services/orchestration/handlers/round-lifecycle.ts');
  const sessionsSrc = readServer('routes/sessions.ts');

  describe('#1 — presence reconcile before matching', () => {
    const fnStart = flowSrc.indexOf('export async function handleHostGenerateMatches');
    const fn = flowSrc.slice(fnStart, flowSrc.indexOf('\nexport ', fnStart + 1));

    it('clears stale "disconnected" for present sockets BEFORE computing eligibility', () => {
      const fetchIdx = fn.indexOf('fetchSockets()');
      // Match the actual CALL (prefixed), not the comment mention of the name.
      const eligIdx = fn.indexOf('matchingService.getEligibleParticipants');
      expect(fetchIdx).toBeGreaterThan(-1);
      expect(eligIdx).toBeGreaterThan(-1);
      // Reconcile must run before eligibility, or it has no effect.
      expect(fetchIdx).toBeLessThan(eligIdx);
      expect(fn).toMatch(/status = 'disconnected'/);
      expect(fn).toMatch(/transitionParticipant\([\s\S]{0,140}ParticipantState\.IN_MAIN_ROOM/);
    });
  });

  describe('#4 — host Event Plan strip refreshes on round start + end', () => {
    it('transitionToRound emits host:event_plan_repaired (round_started)', () => {
      const i = lifecycleSrc.indexOf('export async function transitionToRound');
      const fn = lifecycleSrc.slice(i, lifecycleSrc.indexOf('\nexport ', i + 1));
      expect(fn).toMatch(/host:event_plan_repaired[\s\S]{0,200}round_started/);
    });

    it('endRound emits host:event_plan_repaired (round_ended)', () => {
      const i = lifecycleSrc.indexOf('export async function endRound');
      const fn = lifecycleSrc.slice(i, lifecycleSrc.indexOf('\nexport ', i + 1));
      expect(fn).toMatch(/host:event_plan_repaired[\s\S]{0,200}round_ended/);
    });
  });

  describe('#5 — Re-match reports when no other arrangement is possible', () => {
    const fnStart = flowSrc.indexOf('export async function handleHostRegenerateMatches');
    const fn = flowSrc.slice(fnStart, flowSrc.indexOf('\nexport ', fnStart + 1));

    it('compares before/after arrangement and emits REMATCH_NO_ALTERNATIVE when unchanged', () => {
      expect(fn).toMatch(/beforeArrangement/);
      expect(fn).toMatch(/afterArrangement\s*===\s*beforeArrangement/);
      expect(fn).toMatch(/REMATCH_NO_ALTERNATIVE/);
    });
  });

  describe('#7 — cohosts excluded from the "not matched" tally', () => {
    it('/plan bye-count active_participants excludes session_cohosts (not just the director)', () => {
      const i = sessionsSrc.indexOf("'/:id/plan'");
      expect(i).toBeGreaterThan(-1);
      const block = sessionsSrc.slice(i, i + 5000);
      expect(block).toMatch(/active_participants AS/);
      expect(block).toMatch(/NOT IN \(SELECT user_id FROM session_cohosts/);
    });
  });
});
