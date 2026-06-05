// ─── WS3/G3+G4 (27 May remaining work) — distinct, non-duplicated exits ────
//
// Users confused "leave the breakout room" with "leave the whole event":
// VideoRoom rendered two visually identical buttons (same ArrowLeft icon,
// same gray styling) — "Main Room" and "Leave" — and the page top bar had a
// THIRD exit. New contract:
//   - The breakout room has exactly ONE exit: "Back to Main Room"
//     (room-only, amber). No session:leave from inside VideoRoom.
//   - The EVENT exit is the top bar's destructive red "Leave Event"
//     (LogOut icon) — one event exit for the whole live surface.

import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
}

describe('WS3/G3+G4 — leave buttons are distinct and not duplicated', () => {
  it('VideoRoom has ONE in-room exit: Back to Main Room (no event-leave duplicate)', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).toMatch(/Back to Main Room/);
    // The old duplicate event exit is gone from the room UI.
    expect(src).not.toMatch(/session:leave/);
    expect(src).not.toMatch(/window\.location\.href = '\/sessions'/);
  });

  it('the event exit is the top bar destructive "Leave Event" with the LogOut icon', () => {
    const src = readClient('features/live/LiveSessionPage.tsx');
    const idx = src.indexOf('Leave Event');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, idx - 600), idx + 100);
    expect(block).toMatch(/LogOut/);
    expect(block).toMatch(/text-red-500/);
    expect(block).toMatch(/handleLeave/);
  });

  it('the obsolete "cannot rejoin" copy is gone (post-WS2 only kicks ban re-entry)', () => {
    const src = readClient('features/live/VideoRoom.tsx');
    expect(src).not.toMatch(/not be able to rejoin/);
  });
});
