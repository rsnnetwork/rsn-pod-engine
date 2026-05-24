// 25 May live-test fixes (Ali). See docs/superpowers/plans/2026-05-25-live-test-investigation.md
//   A — return re-registers via session:join (recovery; revert of heartbeat-only)
//   C — rating skip recorded server-side + honored by replay & endRound dedup
//   B — in-breakout users excluded from the main-room tile list
//   F/G — timer:sync scoped to context (round vs breakout); client ignores cross-context ticks
//   H — non-destructive participant refetch (no blank-then-repopulate glimpse)
//   D — LiveKit video re-init on return to foreground

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}
function fnSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  return src.slice(start, src.indexOf('\nexport ', start + 1));
}

describe('25 May live-test fixes', () => {
  describe('A — return re-registers via session:join', () => {
    it('foreground resync emits session:join (not heartbeat-only)', () => {
      const src = readClient('hooks/useSessionSocket.ts');
      const i = src.indexOf('resyncPresenceOnReturn =');
      expect(i).toBeGreaterThan(-1);
      expect(src.slice(i, i + 1000)).toMatch(/emit\(\s*['"]session:join/);
    });
  });

  describe('C — rating skip recorded + honored', () => {
    const pfSrc = readServer('services/orchestration/handlers/participant-flow.ts');

    it('handleRatingSkip records the skip on the session', () => {
      expect(pfSrc).toMatch(/export async function handleRatingSkip/);
      expect(pfSrc).toMatch(/ratingSkips[\s\S]{0,80}\.add\(/);
    });
    it('rating-replay does not re-send when the user skipped this match', () => {
      expect(pfSrc).toMatch(/ratingSkips\?\.has\([\s\S]{0,40}userMatch\.id/);
    });
    it('endRound dedup honors ratingSkips', () => {
      const fn = fnSlice(readServer('services/orchestration/handlers/round-lifecycle.ts'), 'export async function endRound');
      expect(fn).toMatch(/ratingSkips\?\.has\([\s\S]{0,30}match\.id/);
    });
    it('rating:skip is wired server-side and emitted by RatingPrompt on Skip', () => {
      expect(readServer('services/orchestration/orchestration.service.ts')).toMatch(/wrapHandler\('rating:skip'/);
      expect(readClient('features/live/RatingPrompt.tsx')).toMatch(/emit\('rating:skip'/);
    });
  });
});
