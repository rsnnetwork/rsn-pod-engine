// ─── C2 / VID-1 (12 Jun audit) — main-room video diet ──────────────────────
//
// Every participant publishes a 960x540 BG-engine camera track and, before this
// fix, every client full-subscribed every remote camera at the top simulcast
// layer because neither <LiveKitRoom> set adaptiveStream or dynacast. At 50
// participants each viewer decoded ~49 540p streams (~25-80 Mbps) and phones
// (≤8-12 hardware decoders) died. VID-1 turns on:
//   - adaptiveStream  (subscriber-side: layer per rendered tile size; pause
//                      unattached / off-screen video). AUDIO IS NEVER AFFECTED.
//   - dynacast        (publisher-side: stop encoding layers nobody consumes).
//   - pinned sub-layers [h180, h360] + a 24fps/800kbps top-layer encode cap.

import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
}

const ROOMS = ['features/live/Lobby.tsx', 'features/live/VideoRoom.tsx'];

describe('C2 / VID-1 — adaptiveStream + dynacast + pinned simulcast on both rooms', () => {
  it('both <LiveKitRoom> options enable adaptiveStream and dynacast', () => {
    for (const rel of ROOMS) {
      const src = readClient(rel);
      expect(src).toMatch(/adaptiveStream: true/);
      expect(src).toMatch(/dynacast: true/);
    }
  });

  it('both rooms pin the simulcast sub-layers [h180, h360] and cap the top layer at 24fps', () => {
    for (const rel of ROOMS) {
      const src = readClient(rel);
      expect(src).toMatch(/videoSimulcastLayers: \[VideoPresets\.h180, VideoPresets\.h360\]/);
      expect(src).toMatch(/maxFramerate: 24/);
    }
  });

  it('VideoPresets is imported from livekit-client in both rooms', () => {
    for (const rel of ROOMS) {
      const src = readClient(rel);
      expect(src).toMatch(/import \{[^}]*VideoPresets[^}]*\} from 'livekit-client'/);
    }
  });

  it('AUDIO CONTRACT — RoomAudioRenderer stays mounted in both rooms (all mics always rendered)', () => {
    for (const rel of ROOMS) {
      expect(readClient(rel)).toMatch(/<RoomAudioRenderer \/>/);
    }
  });

  it('the pinned capture/audio defaults are preserved byte-for-byte (no regression)', () => {
    for (const rel of ROOMS) {
      const src = readClient(rel);
      expect(src).toMatch(/videoCaptureDefaults: \{ resolution: \{ \.\.\.BG_CAPTURE_RESOLUTION \} \}/);
      expect(src).toMatch(/audioCaptureDefaults: \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true \}/);
    }
  });
});

describe('C2 / VID-2 — lobby tile render cap + overflow', () => {
  const lobby = readClient('features/live/Lobby.tsx');

  it('windows the grid through computeTileWindow and renders gridTracks (not all cameraTracks)', () => {
    expect(lobby).toMatch(/computeTileWindow\(/);
    expect(lobby).toMatch(/gridTracks\.map\(/);
  });

  it('renders a single "+N more" overflow tile with the audio-still-on hint', () => {
    expect(lobby).toMatch(/data-testid="lobby-overflow-tile"/);
    expect(lobby).toMatch(/\+\{overflowCount\} more/);
    expect(lobby).toMatch(/audio still on/);
  });

  it('off-screen tiles use content-visibility for cheap virtualization', () => {
    expect(lobby).toMatch(/\[content-visibility:auto\]/);
  });

  it('keeps the pinned destructure + strip filter assignments verbatim (pin safety)', () => {
    expect(lobby).toMatch(/normalTracks: cameraTracks/);
    expect(lobby).toMatch(/const unpinnedTracks = cameraTracksSorted\.filter\(/);
  });
});
