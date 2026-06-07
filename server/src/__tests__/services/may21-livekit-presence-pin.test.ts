// May 21 follow-up (F3, Ali) — pin the client-side LiveKit-presence
// contract so a future refactor can't silently revert to socket-only
// participant tracking. Reads client source files and asserts the
// shape of the wiring.
//
// Why this pin exists: even after the M1 auto-LEFT removal, the 21 May
// afternoon test still showed per-viewer count divergence (5 actual,
// each viewer saw a different count). User confirmed "upon refresh
// the list works fine" — so the snapshot is right; the post-snapshot
// socket fan-out for participant:joined/left misses some clients.
// LiveKit's room state is the only signal every viewer subscribes to
// the same server-side source for, so it becomes the source of truth
// for in-room presence. This test pins that wiring against drift.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  // Server tests run from server/, so client/ lives at ../client/ from there.
  // __dirname here is server/src/__tests__/services/, which is 3 levels deep.
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client', rel), 'utf8');
}

describe('F3 (21 May Ali) — LiveKit presence is the source of truth for in-room participants', () => {
  describe('Zustand store wiring', () => {
    const src = readClient('src/stores/sessionStore.ts');

    it('declares the liveRoomParticipants field', () => {
      expect(src).toMatch(/liveRoomParticipants:\s*Array<\{\s*userId:\s*string;\s*displayName:\s*string\s*\}>/);
    });

    it('exports the setLiveRoomParticipants setter', () => {
      expect(src).toMatch(/setLiveRoomParticipants:\s*\(list:\s*Array<\{\s*userId:\s*string;\s*displayName:\s*string\s*\}>\)\s*=>\s*void/);
    });

    it('initialises and resets liveRoomParticipants to an empty list', () => {
      // Both the initial state (line ~318 area) and the reset() body must
      // include this field, otherwise the selector silently falls back
      // forever.
      const initMatches = src.match(/liveRoomParticipants:\s*\[\]/g) || [];
      expect(initMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('exports useInRoomParticipants selector that prefers LiveKit when populated', () => {
      expect(src).toMatch(/export function useInRoomParticipants\(\):\s*Participant\[\]/);
      // Empty LiveKit list => fall back to socket roster.
      expect(src).toMatch(/if\s*\(liveRoomParticipants\.length\s*===\s*0\)\s*return\s*storeParticipants/);
      // Non-empty => map LiveKit identities through the store for names.
      expect(src).toMatch(/liveRoomParticipants\.map\(lp\s*=>\s*\(\{/);
    });
  });

  describe('Lobby presence-sync component', () => {
    const src = readClient('src/features/live/Lobby.tsx');

    it('defines LiveKitPresenceSync that reads useParticipants and writes to the store', () => {
      expect(src).toMatch(/function LiveKitPresenceSync\(\)/);
      const idx = src.indexOf('function LiveKitPresenceSync()');
      expect(idx).toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 2000);
      expect(body).toMatch(/useParticipants\(\)/);
      expect(body).toMatch(/setLiveRoomParticipants/);
      // Identity = userId (matches the LiveKit token's identity field).
      expect(body).toMatch(/p\.identity/);
      // Stable-key guard so the store write fires only when membership
      // actually changes (not every LiveKit metadata tick).
      expect(body).toMatch(/lastKeyRef/);
      // Cleanup on unmount: reset the live list so the selector falls
      // back to the socket roster post-LiveKit.
      expect(body).toMatch(/setLiveRoomParticipants\(\[\]\)/);
    });

    it('mounts LiveKitPresenceSync inside the lobby <LiveKitRoom>', () => {
      const idx = src.indexOf('<LiveKitRoom');
      expect(idx).toBeGreaterThan(-1);
      // Find the matching closing tag.
      const end = src.indexOf('</LiveKitRoom>', idx);
      expect(end).toBeGreaterThan(-1);
      const block = src.slice(idx, end);
      expect(block).toMatch(/<LiveKitPresenceSync\s*\/>/);
    });

    it('LobbyStatusOverlay reads the realtime in-room list', () => {
      const idx = src.indexOf('function LobbyStatusOverlay');
      expect(idx).toBeGreaterThan(-1);
      // window widened 600→1000: P2-1 expanded the whole-store destructure
      // into per-field selectors above the call
      const body = src.slice(idx, idx + 1000);
      expect(body).toMatch(/useInRoomParticipants\(\)/);
    });

    it('HostParticipantPanel reads the realtime in-room list', () => {
      const idx = src.indexOf('function HostParticipantPanel');
      expect(idx).toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 600);
      expect(body).toMatch(/useInRoomParticipants\(\)/);
    });

    it('useHostPresence reads the realtime in-room list (so host-online flips at the same time for every viewer)', () => {
      const idx = src.indexOf('function useHostPresence');
      expect(idx).toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 800);
      expect(body).toMatch(/useInRoomParticipants\(\)/);
    });
  });

  describe('Other in-room surfaces use the realtime list', () => {
    it('ParticipantList drawer reads useInRoomParticipants', () => {
      const src = readClient('src/features/live/ParticipantList.tsx');
      expect(src).toMatch(/import\s*\{[^}]*useInRoomParticipants[^}]*\}\s*from\s*'@\/stores\/sessionStore'/);
      expect(src).toMatch(/const participants\s*=\s*useInRoomParticipants\(\)/);
    });

    it('HostControls eligibility/in-room counts read useInRoomParticipants', () => {
      const src = readClient('src/features/live/HostControls.tsx');
      expect(src).toMatch(/import\s*\{[^}]*useInRoomParticipants[^}]*\}\s*from\s*'@\/stores\/sessionStore'/);
      expect(src).toMatch(/const participants\s*=\s*useInRoomParticipants\(\)/);
    });

    it('ChatPanel host-presence check reads useInRoomParticipants', () => {
      const src = readClient('src/features/live/ChatPanel.tsx');
      expect(src).toMatch(/import\s*\{[^}]*useInRoomParticipants[^}]*\}\s*from\s*'@\/stores\/sessionStore'/);
      expect(src).toMatch(/const participants\s*=\s*useInRoomParticipants\(\)/);
    });

    it('ReactionBar host-presence check reads useInRoomParticipants', () => {
      const src = readClient('src/features/live/ReactionBar.tsx');
      expect(src).toMatch(/import\s*\{[^}]*useInRoomParticipants[^}]*\}\s*from\s*'@\/stores\/sessionStore'/);
      expect(src).toMatch(/const participants\s*=\s*useInRoomParticipants\(\)/);
    });
  });
});
