// T2 UI polish batch (Issues 13, 14, 15)
//
// Six small fixes shipped as one logical commit:
//   T2-1 — Lobby tile uses object-contain (matches breakout per April 18 fix)
//   T2-2 — Mirror scope: only remote tracks un-mirrored (local self-view stays mirrored)
//   T2-3 — Responsive grid for 2/3/4 participants
//   T2-4 — Rating UI star color readable on dark background
//   T2-5 — Persistent session-title badge in VideoRoom
//   T2-6 — Background blur fixed (Track.Source enum + strength 10→25)

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');
}

describe('T2 UI polish batch', () => {
  describe('T2-1 — Lobby tile uses object-contain pattern', () => {
    const src = readClient('features/live/Lobby.tsx');

    it('Lobby VideoTrack className conditionally uses object-contain (default) vs object-cover (pinned)', () => {
      // Default unpinned tiles must use object-contain (full frame, no zoom)
      // Pinned tiles still use object-cover (intentional fill on PIP)
      expect(src).toMatch(/isPinned\s*\?\s*['"]object-cover['"]\s*:\s*['"]object-contain['"]/);
    });

    it('wraps unpinned tiles with .rsn-tile-contain class for CSS specificity override', () => {
      expect(src).toMatch(/rsn-tile-contain/);
    });
  });

  describe('T2-2 — global mirror rule scoped to remote tracks only', () => {
    const css = readClient('index.css');

    it('mirror un-do rule targets data-lk-local="false" (remote) only, not all videos', () => {
      // Pre-fix the rule was unscoped: video[style*="scaleX"] { transform: none }
      // Post-fix it requires data-lk-local="false" — local self-view keeps mirroring.
      expect(css).toMatch(/data-lk-local="false"/);
    });

    it('removes the unconditional "video[style*=scaleX]" sledgehammer rule', () => {
      // The exact pre-fix selector should no longer match anything that lacks
      // the data-lk-local="false" qualifier.
      expect(css).not.toMatch(/^video\[style\*="scaleX"\]\s*\{\s*transform:\s*none/m);
    });
  });

  describe('T2-3 — responsive grid for pair vs trio', () => {
    const src = readClient('features/live/VideoRoom.tsx');

    it('pair grid uses grid-cols-1 lg:grid-cols-2 (full-width on small desktop, side-by-side on lg)', () => {
      expect(src).toMatch(/isTrio\s*\?\s*['"]grid-cols-2 lg:grid-cols-3['"]\s*:\s*['"]grid-cols-1 lg:grid-cols-2['"]/);
    });
  });

  describe('T2-4 — rating star color readable (superseded by Phase 7)', () => {
    const src = readClient('features/live/RatingPrompt.tsx');

    // Phase 7 (1 May 2026 spec) flipped the rating surface to white per
    // Stefan's request. Stars are now text-gray-300 (visible on white)
    // instead of text-white/60 (visible on dark). Both are readable
    // contrasts; the surface change is what made Phase 7 supersede T2-4.
    it('unselected stars use a readable contrast (gray-300 on white surface)', () => {
      expect(src).toMatch(/text-gray-300\s+hover:text-gray-400/);
      expect(src).not.toMatch(/text-gray-600\s+hover:text-gray-500/);
    });
  });

  describe('T2-5 — persistent session badge in VideoRoom', () => {
    const src = readClient('features/live/VideoRoom.tsx');

    it('fetches session title via api.get(/sessions/:id) on mount', () => {
      expect(src).toMatch(/api\.get\(`\/sessions\/\$\{sessionId\}`\)/);
      expect(src).toMatch(/setSessionTitle/);
    });

    it('renders session title in the breakout-room badge', () => {
      // The badge area now conditionally renders sessionTitle alongside "Breakout Room"
      expect(src).toMatch(/sessionTitle\s*&&\s*\(/);
    });
  });

  describe('T2-6 — background blur Track.Source enum + bumped strength', () => {
    const vr = readClient('features/live/VideoRoom.tsx');
    const lobby = readClient('features/live/Lobby.tsx');

    it('VideoRoom uses Track.Source.Camera enum (not string "camera")', () => {
      expect(vr).toMatch(/p\.source\s*===\s*Track\.Source\.Camera/);
    });

    it('Lobby uses Track.Source.Camera enum (not string "camera")', () => {
      expect(lobby).toMatch(/p\.source\s*===\s*Track\.Source\.Camera/);
    });

    it('blur strength bumped from 10 to 25 in VideoRoom', () => {
      expect(vr).toMatch(/BackgroundBlur\(25\)/);
    });

    it('blur strength bumped from 10 to 25 in Lobby', () => {
      expect(lobby).toMatch(/BackgroundBlur\(25\)/);
    });
  });
});
