// Phase N — 12 May item 2: multi-host display logic (Primary / Co-host /
// Invisible Admin).
//
// Phase G (May 11) shipped the full backend foundation: the host_visibility_mode
// enum (big_speaker | normal | producer | hidden), DB migration 059, the
// setHostVisibility service, REST endpoint POST /sessions/:id/host/visibility,
// the host:visibility_changed broadcast, the snapshot field, and the client
// store record + helpers. The UI was deferred to a follow-up phase — Phase N
// is that follow-up.
//
// Phase N adds:
//   1. HostControlCenter — Visibility dropdown next to each host/cohost row,
//      wired to POST /sessions/:id/host/visibility with optimistic store
//      update and revert-on-failure.
//   2. Lobby — render effects:
//      - 'hidden' users filtered out of all grids.
//      - 'producer' users rendered in a slim audio-only strip below the
//        main grid (no video tile).
//      - 'big_speaker' users rendered in a dedicated stage row above the
//        main grid (each tile rendered with isPinned styling).
//      - Pinned mode: pin can target any non-hidden user; if a pinned
//        user's mode flips to 'hidden', they auto-unpin.
//   3. VideoRoom (breakout) — hidden tiles filtered out (never hides the
//      local user's own tile). Big-speaker / producer special-casing
//      deferred for breakout since the matching engine excludes hosts.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase N — multi-host visibility UI (item 2)', () => {
  describe('HostControlCenter — visibility dropdown wiring', () => {
    const src = readClient('features/live/HostControlCenter.tsx');

    it('imports api client for the REST call', () => {
      expect(src).toMatch(/import\s+api\s+from\s+['"]@\/lib\/api['"]/);
    });

    it('declares the four-mode HostVisibilityMode union (matches Phase G backend enum)', () => {
      expect(src).toMatch(
        /type\s+HostVisibilityMode\s*=\s*['"]big_speaker['"]\s*\|\s*['"]normal['"]\s*\|\s*['"]producer['"]\s*\|\s*['"]hidden['"]/,
      );
    });

    it('reads hostVisibilityModes + setHostVisibility from the session store', () => {
      expect(src).toMatch(/hostVisibilityModes\s*=\s*useSessionStore\(/);
      // The local handle may be renamed to avoid shadowing the prop-shaped
      // `setVisibility` action handler — accept either bare or prefixed
      // form. What matters: the store's setHostVisibility action is wired.
      expect(src).toMatch(/(?:storeSetHostVisibility|setHostVisibility)\s*=\s*useSessionStore\([\s\S]{0,60}s\.setHostVisibility/);
    });

    it('setVisibility handler posts to /sessions/:id/host/visibility (Phase G REST endpoint)', () => {
      // The endpoint shape was shipped in Phase G; Phase N consumes it.
      // The exact URL template is what matches the server route — pin it.
      expect(src).toMatch(
        /api\.post\(\s*[`'"]\/sessions\/\$\{sessionId\}\/host\/visibility[`'"]\s*,\s*\{\s*userId,\s*mode\s*\}/,
      );
    });

    it('setVisibility does optimistic store update + revert on failure', () => {
      // Pattern: read previous, write new locally, await api.post in try,
      // restore previous in catch.
      const fnStart = src.indexOf('const setVisibility');
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n  };', fnStart) + 5;
      const fn = src.slice(fnStart, fnEnd > fnStart ? fnEnd : src.length);
      // Capture previous value.
      expect(fn).toMatch(/const\s+prev\s*=\s*hostVisibilityModes\[userId\]/);
      // Optimistic local update.
      expect(fn).toMatch(/storeSetHostVisibility\(userId,\s*mode\)/);
      // Revert on error.
      expect(fn).toMatch(/storeSetHostVisibility\(userId,\s*prev\)/);
    });

    it('renders VisibilitySelect only for users with role host or cohost', () => {
      expect(src).toMatch(/p\.role\s*===\s*['"]host['"]\s*\|\|\s*p\.role\s*===\s*['"]cohost['"]/);
      expect(src).toMatch(/<VisibilitySelect/);
    });

    it('VisibilitySelect is defined and exposes all four modes', () => {
      expect(src).toMatch(/function\s+VisibilitySelect\(/);
      expect(src).toMatch(/HOST_VISIBILITY_LABELS:\s*Record<HostVisibilityMode,\s*string>/);
      // All four labels must be enumerated so the dropdown surfaces them.
      const labelsMatch = src.match(/HOST_VISIBILITY_LABELS:[\s\S]+?\};/);
      expect(labelsMatch).toBeTruthy();
      const labels = labelsMatch![0];
      expect(labels).toMatch(/big_speaker:/);
      expect(labels).toMatch(/normal:/);
      expect(labels).toMatch(/producer:/);
      expect(labels).toMatch(/hidden:/);
    });
  });

  describe('Lobby — render effects honour visibility mode', () => {
    const src = readClient('features/live/Lobby.tsx');

    it('reads hostVisibilityModes from the session store', () => {
      expect(src).toMatch(/hostVisibilityModes\s*=\s*useSessionStore\(/);
    });

    it('exposes visibilityFor helper resolving each track to a four-mode value', () => {
      expect(src).toMatch(/visibilityFor\s*=\s*useCallback/);
      // The helper returns the four-mode union.
      expect(src).toMatch(
        /['"]big_speaker['"]\s*\|\s*['"]normal['"]\s*\|\s*['"]producer['"]\s*\|\s*['"]hidden['"]/,
      );
    });

    it('partitions sorted tracks into big_speaker / normal / producer (hidden dropped)', () => {
      expect(src).toMatch(/bigSpeakerTracks\s*=\s*cameraTracksSorted\.filter\([\s\S]{0,80}['"]big_speaker['"]/);
      expect(src).toMatch(/producerTracks\s*=\s*cameraTracksSorted\.filter\([\s\S]{0,80}['"]producer['"]/);
      // The main grid uses `cameraTracks` which is the normal-only subset.
      expect(src).toMatch(/cameraTracks\s*=\s*cameraTracksSorted\.filter/);
    });

    it('renders a dedicated big-speaker stage row above the main grid (when any exist)', () => {
      expect(src).toMatch(/data-testid="lobby-big-speaker-stage"/);
      expect(src).toMatch(/bigSpeakerTracks\.length\s*>\s*0/);
    });

    it('renders a producer strip below the main grid (when any exist)', () => {
      expect(src).toMatch(/data-testid="lobby-producer-strip"/);
      expect(src).toMatch(/producerTracks\.length\s*>\s*0/);
    });

    it('pin auto-unpins when the pinned user becomes hidden', () => {
      // The effect that handles auto-unpin must check visibilityFor on
      // the pinned track and clear pinnedSid when 'hidden'.
      const effectIdx = src.indexOf('Auto-unpin');
      expect(effectIdx).toBeGreaterThan(-1);
      const slice = src.slice(effectIdx, effectIdx + 800);
      expect(slice).toMatch(/visibilityFor\(pinned\)\s*===\s*['"]hidden['"]/);
      expect(slice).toMatch(/setPinnedSid\(null\)/);
    });

    it('pinned-mode strip excludes hidden tracks (but allows big_speaker + producer)', () => {
      // unpinnedTracks must be derived from cameraTracksSorted (NOT the
      // normal-only cameraTracks) so the strip includes all visible roles.
      // Anchor on the unpinnedTracks assignment specifically and capture
      // enough lookahead to include the full filter expression.
      const block = src.match(/const\s+unpinnedTracks\s*=\s*cameraTracksSorted\.filter\([\s\S]{0,300}\)/);
      expect(block).toBeTruthy();
      expect(block![0]).toMatch(/visibilityFor\(t\)\s*!==\s*['"]hidden['"]/);
    });
  });

  describe('VideoRoom (breakout) — hidden filter', () => {
    const src = readClient('features/live/VideoRoom.tsx');

    it('reads hostVisibilityModes from the session store', () => {
      expect(src).toMatch(/hostVisibilityModes\s*=\s*useSessionStore\(/);
    });

    it('filters hidden tiles out of allTiles (never hides the local tile)', () => {
      // The filter clause must protect the local tile (always keep it)
      // and drop tiles whose user is in 'hidden'.
      expect(src).toMatch(
        /tile\.sid\s*===\s*localParticipant\.sid[\s\S]{0,150}hostVisibilityModes\[tile\.userId\][\s\S]{0,80}!==\s*['"]hidden['"]/,
      );
    });
  });

  describe('Backend reuse — Phase N depends on Phase G plumbing', () => {
    it('Phase G enum, snapshot, and store helpers are still in place (cross-ref)', () => {
      // If any of these get removed, Phase N's UI breaks. Pin the
      // upstream dependencies that Phase N consumes.
      const storeSrc = readClient('stores/sessionStore.ts');
      const sockSrc = readClient('hooks/useSessionSocket.ts');
      expect(storeSrc).toMatch(/hostVisibilityModes:\s*Record<string,/);
      expect(storeSrc).toMatch(/setHostVisibility:\s*\(userId/);
      expect(storeSrc).toMatch(/setHostVisibilityModes:\s*\(modes/);
      expect(sockSrc).toMatch(/host:visibility_changed/);
    });
  });
});
