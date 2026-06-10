// ─── S21 — hold the roster during the viewer's own reconnect (live-test z1)
//
// With 12 browsers saturating one laptop, the HOST's LiveKit connection
// renegotiated a few times; for 2–4s every remote track vanished and the
// main room flashed "0 participants + 1 host". Truth is unreachable during
// the viewer's own blip, so the UI now freezes the last good roster with an
// explicit "Reconnecting…" badge — never a stale list presented as live:
//   - normal operation untouched (joins/leaves apply instantly);
//   - hold engages ONLY while connectionState !== Connected;
//   - hard cap 15s, then fall back to whatever the room reports;
//   - held tiles are passive placeholders (no stale mute/pin controls).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

const lobbySrc = () => readClient('features/live/Lobby.tsx');

describe('S21 — LobbyMosaic reconnect hold', () => {
  it('reads the LiveKit connection state and derives the hold from it', () => {
    const src = lobbySrc();
    expect(src).toMatch(/useConnectionState,[\s\S]*?from '@livekit\/components-react'/);
    expect(src).toMatch(/reconnecting = connectionState !== ConnectionState\.Connected/);
  });

  it('snapshots the last good roster only while connected (no stale refresh mid-blip)', () => {
    const src = lobbySrc();
    const idx = src.indexOf('const heldRosterRef');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx - 400, idx + 900);
    expect(block).toMatch(/if \(!reconnecting\) \{/);
    expect(block).toMatch(/heldRosterRef\.current = cameraTracksSorted\.map/);
  });

  it('caps the hold at 15s and re-renders at the deadline', () => {
    const src = lobbySrc();
    expect(src).toMatch(/holdDeadlineRef\.current = Date\.now\(\) \+ 15_000/);
    expect(src).toMatch(/Date\.now\(\) < holdDeadlineRef\.current/);
    expect(src).toMatch(/setHoldTick\(x => x \+ 1\)/);
  });

  it('held grid renders placeholder tiles + the Reconnecting badge (no live controls)', () => {
    const src = lobbySrc();
    const idx = src.indexOf('data-testid="lobby-reconnect-hold"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1600);
    expect(block).toMatch(/Reconnecting…/);
    // Passive placeholders only — no VideoTrack, no host mute buttons.
    expect(block).not.toMatch(/VideoTrack/);
    expect(block).not.toMatch(/handleHostMute/);
  });
});

describe('S21 — LiveKitPresenceSync holds the published roster during reconnect', () => {
  it('skips the store write while not Connected, capped at 15s', () => {
    const src = lobbySrc();
    const idx = src.indexOf('function LiveKitPresenceSync');
    expect(idx).toBeGreaterThan(-1);
    const fn = src.slice(idx, idx + 2500);
    expect(fn).toMatch(/connectionState !== ConnectionState\.Connected/);
    expect(fn).toMatch(/return; \/\/ hold last roster/);
    expect(fn).toMatch(/Date\.now\(\) \+ 15_000/);
  });
});
