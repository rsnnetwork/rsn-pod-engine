// 26 May (Ali, live-test-3) — three fixes:
//   A — platform_wide must never surface the pre-plan (it lacks the cross-event
//       hard-exclusion the live engine applies), so "Match People" shows fresh
//       on the first click instead of "met first, fresh on re-match".
//   B — recap "Mutual interest" badge must reflect THIS event (both rated
//       meet-again here), not the lifetime encounter_history.mutual_meet_again
//       (which showed the badge on a recap reporting 0 mutual matches).
//   C — a pulled-out pair who already rated must NOT be re-prompted when the
//       host presses End Round (session:round_ended broadcasts phase='rating').

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('26 May live-test-3 fixes', () => {
  describe('A — platform_wide never surfaces the (un-excluded) pre-plan', () => {
    const src = readServer('services/orchestration/handlers/matching-flow.ts');
    it('gates pre-plan surfacing on matchingPolicy !== platform_wide', () => {
      expect(src).toMatch(/resolveMatchingPolicy\(activeSession\.config\)/);
      expect(src).toMatch(/canSurfacePrePlan\s*=\s*sameMembers && !planRepeatsPriorRound && matchingPolicy !== 'platform_wide'/);
      expect(src).toMatch(/if \(canSurfacePrePlan\)/);
    });
  });

  describe('B — recap Mutual interest badge uses THIS-event mutual, not lifetime', () => {
    it('SessionComplete badge gates on meetAgain && theirMeetAgain (not bare mutualMeetAgain)', () => {
      const s = readClient('features/live/SessionComplete.tsx');
      const i = s.indexOf('function InterestBadge');
      expect(i).toBeGreaterThan(-1);
      const fn = s.slice(i, i + 700);
      expect(fn).toMatch(/connection\.meetAgain && connection\.theirMeetAgain/);
      expect(fn).not.toMatch(/if \(connection\.mutualMeetAgain\)/);
    });
    it('RecapPage badge gates on meetAgain && theirMeetAgain', () => {
      const s = readClient('features/sessions/RecapPage.tsx');
      const i = s.indexOf('function InterestBadge');
      expect(i).toBeGreaterThan(-1);
      const fn = s.slice(i, i + 700);
      expect(fn).toMatch(/connection\.meetAgain && connection\.theirMeetAgain/);
      expect(fn).not.toMatch(/if \(connection\.mutualMeetAgain\)/);
    });
  });

  describe('C — RatingPrompt does not re-show an already-settled match', () => {
    const s = readClient('features/live/RatingPrompt.tsx');
    it('short-circuits (render + redirect) when the current match is in ratedMatchIds', () => {
      expect(s).toMatch(/alreadySettledMatch\s*=\s*!!currentMatchId && ratedMatchIds\.has\(currentMatchId\)/);
      expect(s).toMatch(/if \(alreadySettledMatch\) return null/);
      expect(s).toMatch(/if \(alreadySettledMatch && !hasRedirected\.current\)/);
    });
  });
});
