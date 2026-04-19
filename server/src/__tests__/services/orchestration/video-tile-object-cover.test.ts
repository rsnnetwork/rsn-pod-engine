// Bug 6 (April 18 round 2) — VideoTile uses object-CONTAIN, not object-cover.
//
// History:
//   - Original Bug #2 hotfix forced object-cover universally to stop mobile
//     letterbox bars on portrait video. That fix overshot: portrait phone
//     video rendered in landscape DESKTOP tiles got cropped so aggressively
//     that only the centre slice of the face was visible (Bug 6 reported
//     during 2026-04-18 live test).
//   - Bug 6 fix reverts to object-CONTAIN with bg-black on the parent. The
//     full source frame is preserved and padded with the tile's bg colour.
//     Matches Google Meet / FaceTime portrait-on-desktop behaviour.
//
// This file pins the new architectural rule so future "fix" attempts that
// flip back to object-cover fail fast in CI.

describe('Bug 6 — VideoTile uses object-contain (preserves full source frame)', () => {
  let videoRoomSrc = '';

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');
    videoRoomSrc = fs.readFileSync(
      path.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
  });

  it('VideoTrack className supports both object-contain (default) and object-cover (PIP)', () => {
    // Bug 16 (April 19) — VideoTile now accepts a fillMode prop. Default is
    // contain (breakout tiles, no crop). PIP self-view uses cover (small
    // portrait container — contain would visibly shrink the user via side
    // bars). The className expression is a ternary on fillMode.
    const videoTrackBlocks = videoRoomSrc.match(/<VideoTrack[\s\S]*?\/>/g) || [];
    expect(videoTrackBlocks.length).toBeGreaterThan(0);
    for (const block of videoTrackBlocks) {
      expect(block).toMatch(/fillMode\s*===\s*['"]contain['"][\s\S]*object-contain[\s\S]*object-cover/);
    }
  });

  it('Parent tile keeps bg-black so letterbox padding feels intentional', () => {
    // bg-black on the wrapper (when hasVideo) ensures the contain padding
    // looks like an editorial frame, not a broken tile.
    expect(videoRoomSrc).toMatch(/hasVideo\s*\?\s*['"`]bg-black/);
  });

  it('Mobile self-view PIP renders VideoTile with fillMode="cover"', () => {
    // Bug 16 (April 19) — PIP self-views explicitly opt into cover mode.
    // contain visibly shrinks the user in a small portrait container
    // (side bars on portrait video inside portrait container). Confirm
    // BOTH PIP wrappers (1:1 mobile + trio mobile) pass fillMode="cover".
    const pipMatches = videoRoomSrc.match(/w-32 h-44 sm:w-36 sm:h-48[\s\S]{0,1000}<VideoTile[\s\S]{0,500}fillMode="cover"/g);
    expect(pipMatches).not.toBeNull();
    expect((pipMatches || []).length).toBeGreaterThanOrEqual(2);
  });
});
