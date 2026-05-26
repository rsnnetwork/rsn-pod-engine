// 27 May — the in-call virtual-background ("BG") button is gated behind a
// default-OFF feature flag for events. MediaPipe segmentation runs per-frame on
// the participant's own machine and can hang weaker laptops mid-event. Both the
// button AND the auto-re-apply of a saved preference must be gated, in BOTH the
// main room (Lobby) and breakout rooms (VideoRoom).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

describe('Background effects gated for events', () => {
  it('feature flag exists and defaults OFF', () => {
    const f = readClient('lib/featureFlags.ts');
    expect(f).toMatch(/export const BACKGROUND_EFFECTS_ENABLED\s*=\s*false/);
  });

  for (const file of ['features/live/VideoRoom.tsx', 'features/live/Lobby.tsx']) {
    it(`${file} imports the flag and gates BOTH the button and the auto-apply`, () => {
      const s = readClient(file);
      expect(s).toMatch(/import \{ BACKGROUND_EFFECTS_ENABLED \} from '@\/lib\/featureFlags'/);
      // BG button render is gated
      expect(s).toMatch(/\{BACKGROUND_EFFECTS_ENABLED && \([\s\S]{0,220}setShowBgPanel/);
      // saved-preference auto-apply effect is gated (so returning users don't spin it up)
      expect(s).toMatch(/if \(!BACKGROUND_EFFECTS_ENABLED\) return;[\s\S]{0,160}loadBgPreference/);
    });
  }
});
