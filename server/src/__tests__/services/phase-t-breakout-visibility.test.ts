// Phase T — Phase N deferred follow-up. Apply host visibility modes in
// the breakout (VideoRoom) as well as the lobby. Shared via the new
// useVisibilityPartition hook so the four-mode logic lives in exactly
// one place.
//
// Behaviour in breakouts:
//   • Hidden — host filtered out of the room entirely.
//   • Producer — host moved into an audio-only pill row below the grid.
//   • Big_speaker — no special render in the 2-3 person breakout (tile
//     is already prominent at that count).
//   • Normal — regular grid tile.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase T — breakout visibility (Phase N follow-up)', () => {
  describe('Shared hook useVisibilityPartition', () => {
    const src = readClient('features/live/useVisibilityPartition.ts');

    it('exports HostVisibilityMode union with the four modes', () => {
      expect(src).toMatch(
        /export\s+type\s+HostVisibilityMode\s*=\s*['"]big_speaker['"]\s*\|\s*['"]normal['"]\s*\|\s*['"]producer['"]\s*\|\s*['"]hidden['"]/,
      );
    });

    it('exports VisibilityPartition interface + useVisibilityPartition hook', () => {
      expect(src).toMatch(/export\s+interface\s+VisibilityPartition/);
      expect(src).toMatch(/export\s+function\s+useVisibilityPartition/);
    });

    it('hook partitions into bigSpeakerTracks / producerTracks / normalTracks; hidden dropped', () => {
      expect(src).toMatch(/bigSpeakerTracks:/);
      expect(src).toMatch(/producerTracks:/);
      expect(src).toMatch(/normalTracks:/);
      // 'hidden' falls through (not pushed into any bucket).
      expect(src).toMatch(/['"]hidden['"][\s\S]{0,200}deliberately falls through/);
    });

    it('visibilityFor returns "normal" when track has no identity or no mode', () => {
      // Defensive — placeholder LiveKit tracks may have no identity yet.
      expect(src).toMatch(/if\s*\(\s*!id\s*\)\s*return\s+['"]normal['"]/);
      expect(src).toMatch(/return\s+['"]normal['"]/);
    });
  });

  describe('Lobby consumes the shared hook (Phase N refactor)', () => {
    const src = readClient('features/live/Lobby.tsx');

    it('imports useVisibilityPartition from the shared module', () => {
      expect(src).toMatch(/import\s+\{\s*useVisibilityPartition\s*\}\s+from\s+['"]\.\/useVisibilityPartition['"]/);
    });

    it('destructures bigSpeakerTracks / producerTracks / normalTracks from the hook', () => {
      expect(src).toMatch(
        /useVisibilityPartition\(\s*cameraTracksSorted,\s*hostVisibilityModes\s*\)/,
      );
      expect(src).toMatch(/bigSpeakerTracks/);
      expect(src).toMatch(/producerTracks/);
      // The main grid still uses `cameraTracks` for backward-compat,
      // aliased to normalTracks from the hook.
      expect(src).toMatch(/normalTracks:\s*cameraTracks/);
    });
  });

  describe('VideoRoom (breakout) filters remoteTracks + renders producer strip', () => {
    const src = readClient('features/live/VideoRoom.tsx');

    it('filters hidden + producer users from remoteTracks (local exempt)', () => {
      // remoteTracksAll is the unfiltered set; remoteTracks is the
      // grid set (drops hidden + producer); producerTracks is the strip.
      expect(src).toMatch(/remoteTracksAll/);
      expect(src).toMatch(
        /producerTracks\s*=\s*remoteTracksAll\.filter[\s\S]{0,200}['"]producer['"]/,
      );
      expect(src).toMatch(
        /remoteTracks\s*=\s*remoteTracksAll\.filter[\s\S]{0,200}m\s*!==\s*['"]hidden['"]\s*&&\s*m\s*!==\s*['"]producer['"]/,
      );
    });

    it('renders the producer strip with the breakout-specific test id', () => {
      expect(src).toMatch(/data-testid="breakout-producer-strip"/);
      expect(src).toMatch(/producerTracks\.length\s*>\s*0/);
    });

    it('producer strip renders one pill per producer with display name', () => {
      const stripIdx = src.indexOf('data-testid="breakout-producer-strip"');
      expect(stripIdx).toBeGreaterThan(-1);
      const block = src.slice(stripIdx, stripIdx + 800);
      expect(block).toMatch(/producerTracks\.map/);
      expect(block).toMatch(/t\.participant\.name\s*\|\|\s*t\.participant\.identity/);
    });

    it('modeFor helper resolves the 4-mode union (same shape as the shared hook)', () => {
      // VideoRoom inlines modeFor rather than importing useVisibilityPartition
      // because it needs filter semantics, not the partition shape. The
      // function-level mode resolution must match the hook for consistency.
      expect(src).toMatch(/modeFor[\s\S]{0,200}['"]big_speaker['"][\s\S]{0,80}['"]producer['"][\s\S]{0,80}['"]hidden['"]/);
    });
  });
});
