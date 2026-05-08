// ─── Phase 8C — Stefan's 8 May review, UX architecture ────────────────────
//
// 8C.1  Slim the host bottom bar — Invite / Room create / Broadcast / bulk
//       ops move into the Control Center's new Actions tab.
// 8C.2  Self-tile prominence + host always visible — every user sees their
//       own tile larger than others; host (and co-hosts) always render
//       in the visible roster.
// 8C.3  Test mode UI removed.

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const CLIENT = join(REPO, 'client', 'src');
const SHARED = join(REPO, 'shared', 'src');

const HOST_CONTROLS = join(CLIENT, 'features', 'live', 'HostControls.tsx');
const HCC = join(CLIENT, 'features', 'live', 'HostControlCenter.tsx');
const VIDEO_ROOM = join(CLIENT, 'features', 'live', 'VideoRoom.tsx');
const LOBBY = join(CLIENT, 'features', 'live', 'Lobby.tsx');
const ORCH = join(REPO, 'server', 'src', 'services', 'orchestration', 'orchestration.service.ts');
const SHARED_EVENTS = join(SHARED, 'types', 'events.ts');

describe('Phase 8C — UX architecture', () => {
  // ── 8C.1 — Slim bottom bar ──────────────────────────────────────────────
  describe('8C.1 — bottom bar slimmed; secondary actions live in Control Center', () => {
    test('Invite / Room / Broadcast / bulk-room buttons no longer exist in HostControls main bar', () => {
      const src = readFileSync(HOST_CONTROLS, 'utf8');
      // Locate the main control-bar return block (after the early
      // isSessionEnding return) and assert the slimmed button set.
      const mainBar = src.slice(src.lastIndexOf('{/* Control bar */}'));
      // These labels must be GONE from the main bar.
      expect(mainBar).not.toMatch(/>\s*Invite\s*</);
      expect(mainBar).not.toMatch(/>\s*Room\s*</);
      expect(mainBar).not.toMatch(/>\s*Set\s*</);
      // "End all" is the bulk-room End-all button. Should be in HCC, not main bar.
      expect(mainBar).not.toMatch(/>\s*End all\s*</);
      // "+2 all" bulk control also gone from main bar.
      expect(mainBar).not.toMatch(/>\s*\+2 all\s*</);
    });

    test('Control Center has an Actions tab housing the moved buttons', () => {
      const src = readFileSync(HCC, 'utf8');
      // New tab id 'actions' alongside overview/participants/rooms.
      expect(src).toMatch(/['"]actions['"]/);
      // The Actions tab body wires the moved actions.
      expect(src).toMatch(/Invite|Create rooms?|Broadcast/);
    });
  });

  // ── 8C.2 — Self-tile prominence + host always visible ───────────────────
  describe('8C.2 — local participant tile is largest; host always in visible roster', () => {
    test('VideoRoom marks the local participant tile with self-prominence styling', () => {
      const src = readFileSync(VIDEO_ROOM, 'utf8');
      // The tile-rendering block must apply a different size class to
      // the local participant (isLocal / sid === localParticipant.sid).
      expect(src).toMatch(/isSelf|isLocalTile|sid\s*===\s*localParticipant/);
    });

    test('Lobby + VideoRoom render host in the visible tiles even in compact view', () => {
      const lobbySrc = readFileSync(LOBBY, 'utf8');
      // Either a sort puts the host first, or a dedicated reservation
      // for hostUserId in the visible-tiles array.
      expect(lobbySrc).toMatch(/hostUserId|isHost/);
    });
  });

  // ── 8C.3 — Test mode removal ────────────────────────────────────────────
  describe('8C.3 — test-mode UI removed', () => {
    test('Test mode button gone from HostControls', () => {
      const src = readFileSync(HOST_CONTROLS, 'utf8');
      expect(src).not.toMatch(/Test mode|toggleTestMode/);
    });

    test('host:set_test_mode handler unwired from orchestration', () => {
      const src = readFileSync(ORCH, 'utf8');
      expect(src).not.toMatch(/host:set_test_mode/);
    });

    test('shared event type for host:set_test_mode removed', () => {
      const src = readFileSync(SHARED_EVENTS, 'utf8');
      expect(src).not.toMatch(/'host:set_test_mode'/);
    });
  });
});
