// Phase X — 13 May live-test bug fixes.
//
// Two bugs surfaced during the live test with Ali, Raja Ali King and
// Haseem Javed:
//
//   Bug 5 — mutual matches count counted per-round-pair (COUNT(*)) instead
//           of per-distinct-partner. Three rounds of the same pair both
//           saying "meet again" rendered as 3 mutual matches; spec says 1.
//
//   Bug 10 — once the host ends the event, the participant-side top-bar
//            controls (participants toggle + leave button), chat panel,
//            and participant list panel all stayed visible alongside the
//            recap. Spec: when phase=complete, only the recap renders.
//
// Both fixes are pinned here so they cannot silently revert.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServerSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClientSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('Phase X — 13 May live-test bug fixes', () => {
  describe('Bug 5 — mutual matches dedup by partner_id', () => {
    const src = readServerSource('services/meeting-records/meeting-records.service.ts');

    it('getMutualMatches uses COUNT(DISTINCT partner_id), not COUNT(*)', () => {
      const fnStart = src.indexOf('export async function getMutualMatches');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      expect(fn).toMatch(/COUNT\(DISTINCT\s+partner_id\)/i);
      // Forbid the previous buggy form — a regression would put COUNT(*)
      // back which counts every meeting_records row including repeats.
      expect(fn).not.toMatch(/COUNT\(\*\)/);
    });

    it('getMeetingCounts.mutual uses COUNT(DISTINCT partner_id) FILTER', () => {
      const fnStart = src.indexOf('export async function getMeetingCounts');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);
      // The "mutual" column inside the SELECT must dedupe by partner_id.
      // The other two columns (unique_people, total) keep their existing
      // forms — only the mutual column had the bug.
      expect(fn).toMatch(/COUNT\(DISTINCT\s+partner_id\)\s+FILTER\s*\(\s*WHERE\s+is_mutual\s*=\s*TRUE\s*\)/i);
    });
  });

  describe('Bug 10 — event-controls hidden when phase = complete', () => {
    const src = readClientSource('features/live/LiveSessionPage.tsx');

    it('top-bar participant toggle + leave buttons wrapped in phase !== complete gate', () => {
      // The two buttons (Users icon toggle + Leave) live in the same
      // flex container. After the fix that container must be conditional
      // on phase !== 'complete'.
      const gate = src.match(/\{phase !== 'complete' && \(\s*<div className="flex items-center gap-1">/);
      expect(gate).not.toBeNull();
    });

    it('participant list panel render-gated by phase !== complete', () => {
      expect(src).toMatch(/participantListOpen && !chatOpen && phase !== 'complete'/);
    });

    it('chat panel render-gated by phase !== complete', () => {
      expect(src).toMatch(/chatOpen && phase !== 'complete'/);
    });

    it('reaction bar already gated by phase !== complete (pre-existing invariant)', () => {
      expect(src).toMatch(/phase !== 'complete' && phase !== 'rating' && sessionId/);
    });

    it('chat toggle button already gated by phase !== complete (pre-existing)', () => {
      expect(src).toMatch(/!chatOpen && phase !== 'complete'/);
    });

    it('host controls already gated by phase !== complete (pre-existing)', () => {
      expect(src).toMatch(/isHost && phase !== 'complete' && <HostControls/);
    });
  });
});
