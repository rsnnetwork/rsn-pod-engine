// Phase 7 (1 May 2026 spec) — UI palette pass + recap nav
//
// Stefan item 8: 'Rating screen wrong color (should be white)'.
// Pre-Phase-7, RatingPrompt and RatingConfirmation rendered on the dark
// bg-[#292a2d] surface inconsistent with the rest of the app (lobby is
// white, profile pages are white). The Phase 1 (29 April) "stars wrong
// color" fix added text-white/60 to make stars visible on the dark
// surface — Stefan's deeper request was to fix the surface, not the
// stars.

import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
}

describe('Phase 7 — UI palette + recap nav', () => {
  describe('Rating prompt renders on white surface', () => {
    const src = readClient('features/live/RatingPrompt.tsx');

    it('rating card uses bg-white with bordered surface', () => {
      // The two card surfaces (rating form + confirmation) should both
      // explicitly use bg-white.
      const bgWhiteCount = (src.match(/bg-white/g) || []).length;
      expect(bgWhiteCount).toBeGreaterThanOrEqual(2);
    });

    it('rating card root no longer uses bg-[#292a2d] (white surface now)', () => {
      // Pre-Phase-7 the rating card root used bg-[#292a2d]. Now bg-white.
      // Only count occurrences inside JSX className strings, not comments.
      // Strip line comments first.
      const stripped = src.replace(/\/\/[^\n]*/g, '');
      const cardClassMatches = stripped.match(/className="[^"]*bg-\[#292a2d\][^"]*"/g) || [];
      // The timer pill at L212 (top-4 right-4 ... bg-[#292a2d]/80) is a
      // separate non-rating surface. Filter it out.
      const ratingCardOccurrences = cardClassMatches.filter(c => !c.includes('top-4 right-4'));
      expect(ratingCardOccurrences.length).toBe(0);
    });

    it('headline uses dark text on white (text-[#1a1a2e])', () => {
      // WS2 (27 May remaining work) — the headline text became dynamic
      // (ratingCopy(reason).heading drives "Your partner didn't return" /
      // "Rate your last conversation" / the default). Pin the palette on
      // the h2 itself plus the default copy still existing in ratingCopy.
      expect(src).toMatch(/<h2 className="text-xl font-bold text-\[#1a1a2e\][^"]*">\{ratingCopy\(reason\)\.heading\}<\/h2>/);
      expect(src).toMatch(/Rate your conversation/);
    });

    it('star colour for unrated changed from white-tint to gray (visible on white)', () => {
      // Old: text-white/60. New: text-gray-300.
      expect(src).toMatch(/text-gray-300\s+hover:text-gray-400/);
      expect(src).not.toMatch(/text-white\/60/);
    });

    it('confirmation success icon uses bg-emerald-50 (white surface palette)', () => {
      expect(src).toMatch(/bg-emerald-50\s+text-emerald-600/);
    });
  });
});
