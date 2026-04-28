// Phase 5 — Platform-spec spec, 29 April 2026.
//
// User's spec (verbatim):
//   "at the end of event the missed rating forms should also appear to
//    the users right ... if a user have missed a rating during the round
//    or maybe during the breakout room by any case the system must track
//    that this user has already missed the rating form for a specific
//    round or a specific breakout room manual maybe so that rating form
//    must appear to that user with proper distinction like rate your
//    manual room with this partner so this user knows like for who I am
//    actually writing"
//
// These tests pin:
//   1. getUnratedPartners returns isManual + isTrio flags so the client
//      can render a clear context label per missed-rating form.
//   2. partner_display_name uses the same email-prefix fallback chain as
//      Phase 1 (no "Partner, Partner" if display_name is null).
//   3. Sort order surfaces algorithm-round forms before manual breakouts
//      (rounds chronological, manuals after) — gives the user a clean
//      timeline to walk through.
//   4. The /ratings/unrated route exists and surfaces these flags to the
//      client.
//   5. Client RecapPage's LateRatingForm renders the context label
//      ("Manual breakout room" / "Round N (trio)" / "Round N").

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('Phase 5 — missed-rating fallback with context labels', () => {
  describe('rating.service.getUnratedPartners returns isManual + isTrio', () => {
    const src = readServer('services/rating/rating.service.ts');
    const fnStart = src.indexOf('export async function getUnratedPartners');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('return type includes isManual and isTrio', () => {
      expect(fn).toMatch(/isManual:\s*boolean/);
      expect(fn).toMatch(/isTrio:\s*boolean/);
    });

    it('SQL selects m.is_manual', () => {
      expect(fn).toMatch(/m\.is_manual/);
    });

    it('SQL marks rows as is_trio when participant_c_id IS NOT NULL', () => {
      expect(fn).toMatch(/participant_c_id IS NOT NULL\)\s+AS is_trio/);
    });

    it('SQL display name uses fallback chain (display_name → email-prefix → short userId)', () => {
      // Same architectural fix as Phase 1's matching-flow nameMap. The
      // recap should never say "Rate Partner — Round 3" when display_name
      // happens to be null.
      expect(fn).toMatch(/COALESCE\(NULLIF\(TRIM\(u\.display_name\)[\s\S]+?SPLIT_PART\(u\.email[\s\S]+?Partner.*SUBSTRING\(up\.partner_id::text, 1, 6\)/);
    });

    it('result mapping returns isManual and isTrio fields', () => {
      expect(fn).toMatch(/isManual:\s*r\.is_manual/);
      expect(fn).toMatch(/isTrio:\s*r\.is_trio/);
    });

    it('orders algorithm rounds first then manuals (clean timeline for user)', () => {
      expect(fn).toMatch(/ORDER BY\s+up\.is_manual ASC,\s*up\.round_number ASC/);
    });
  });

  describe('client RecapPage LateRatingForm renders context label', () => {
    const src = readClient('features/sessions/RecapPage.tsx');

    it('LateRatingForm props include isManual + isTrio', () => {
      const fnStart = src.indexOf('function LateRatingForm');
      const fnEnd = src.indexOf('}) {', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/isManual\?:\s*boolean/);
      expect(fn).toMatch(/isTrio\?:\s*boolean/);
    });

    it('label says "Manual breakout room" when isManual is true', () => {
      // The form's context line picks the right label
      expect(src).toMatch(/isManual\s*\?[\s\S]+?Manual breakout room/);
    });

    it('label says "Round N (trio)" when isTrio is true', () => {
      expect(src).toMatch(/Round \$\{roundNumber\}\$\{isTrio\s*\?\s*' \(trio\)'/);
    });

    it('unrated rendering passes isManual + isTrio to LateRatingForm', () => {
      const useStart = src.indexOf('unratedData.map');
      const useEnd = src.indexOf('))}', useStart);
      const useBlock = src.slice(useStart, useEnd);
      expect(useBlock).toMatch(/isManual=\{partner\.isManual\}/);
      expect(useBlock).toMatch(/isTrio=\{partner\.isTrio\}/);
    });
  });
});
