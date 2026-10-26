// ─── P2-1 for the video-meeting room (26 Oct 2026) ──────────────────────────────
//
// P2-1 (7 Jun): a bare `useSessionStore()` re-renders its component on EVERY store
// write (each timer tick, every chat message, every presence change); in a video
// room that cascades into every tile. The live components read single fields
// instead (services/p2-event-reliability.test.ts pins the speed-networking files).
// The meeting room, its stage, its bar and its media toggles keep the same rule.

import * as fs from 'fs';
import * as path from 'path';

const clientSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('P2-1 — the meeting files subscribe to fields, never the whole store', () => {
  it('no bare whole-store subscription in the meeting room', () => {
    const files = [
      'features/live/meeting/MeetingRoom.tsx',
      'features/live/meeting/MeetingStage.tsx',
      'features/live/meeting/MeetingControlBar.tsx',
      'features/live/meeting/MeetingEnded.tsx',
      'features/live/meeting/useLocalMediaToggles.ts',
      'features/live/useEventInviteLink.ts',
      'features/live/useChatSend.ts',
    ];
    for (const f of files) {
      const src = clientSrc(f);
      expect(`${f}: ${/=\s*useSessionStore\(\);/.test(src)}`).toBe(`${f}: false`);
    }
  });
});
