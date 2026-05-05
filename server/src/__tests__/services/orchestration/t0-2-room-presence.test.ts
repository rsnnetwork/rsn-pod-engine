// T0-2 — explicit LiveKit room presence (Issue 7)
//
// Pre-fix: emitHostDashboard reported `isConnected: true` the moment a
// participant's socket joined the session room, even before their LiveKit
// client had finished WebRTC negotiation. The host dashboard would show
// rooms as "active" while participants were still loading — a fake
// transition.
//
// Post-fix: a participant only counts as "in the room" once their client
// has emitted `presence:room_joined` after `LiveKitRoom.onConnected`. Falls
// back to socket presence when the BREAKOUT_REQUIRE_ROOM_JOINED flag is
// off (legacy path) or when the session has no roomParticipants map
// (pre-upgrade sessions).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(relPath: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../services/orchestration/handlers', relPath),
    'utf8',
  );
}

describe('T0-2 — server side: roomParticipants tracking', () => {
  describe('ActiveSession interface carries roomParticipants', () => {
    it('session-state.ts declares roomParticipants on ActiveSession', () => {
      const src = nodeFs.readFileSync(
        nodePath.join(__dirname, '../../../services/orchestration/state/session-state.ts'),
        'utf8',
      );
      expect(src).toMatch(/roomParticipants\?:\s*Map<string,\s*\{\s*matchId:\s*string;\s*roomId:\s*string;\s*joinedAt:\s*Date\s*\}>/);
    });
  });

  describe('participant-flow.ts exports the new handler + cleanup helpers', () => {
    const src = readSource('participant-flow.ts');

    it('exports handleRoomJoined', () => {
      expect(src).toMatch(/export async function handleRoomJoined\(/);
    });

    it('exports clearRoomParticipant + clearRoomParticipantsForMatch', () => {
      expect(src).toMatch(/export function clearRoomParticipant\(/);
      expect(src).toMatch(/export function clearRoomParticipantsForMatch\(/);
    });

    it('handleRoomJoined assigns the room via setRoomAssignment + triggers dashboard refresh', () => {
      // Phase 2D (5 May spec) — direct roomParticipants.set was replaced with
      // the setRoomAssignment chokepoint helper. The pin now asserts the
      // chokepoint is used; the helper itself is verified at its own
      // definition site.
      const fnStart = src.indexOf('export async function handleRoomJoined(');
      const nextExport = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, nextExport > -1 ? nextExport : src.length);
      expect(fn).toMatch(/setRoomAssignment\(/);
      expect(fn).toMatch(/_emitHostDashboard\(data\.sessionId\)/);
    });

    it('handleDisconnect clears roomParticipants entry via clearRoomParticipant', () => {
      const handlerStart = src.indexOf('export async function handleDisconnect(');
      const handlerEnd = src.indexOf('\nexport ', handlerStart + 1);
      const handler = src.slice(handlerStart, handlerEnd);
      // Phase 2D — direct .delete() chain replaced with the wrapper helper.
      expect(handler).toMatch(/clearRoomParticipant\(sessionId,\s*userId\)/);
    });
  });

  describe('orchestration.service registers presence:room_joined', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../services/orchestration/orchestration.service.ts'),
      'utf8',
    );

    it('imports handleRoomJoined from participant-flow', () => {
      expect(src).toMatch(/handleRoomJoined,/);
    });

    it("registers socket.on('presence:room_joined', ...)", () => {
      expect(src).toMatch(/socket\.on\(['"]presence:room_joined['"]/);
    });
  });

  describe('emitHostDashboard chooses presence source via feature flag', () => {
    const src = readSource('matching-flow.ts');

    it('reads BREAKOUT_REQUIRE_ROOM_JOINED env (default on)', () => {
      expect(src).toMatch(/BREAKOUT_REQUIRE_ROOM_JOINED/);
      // Default behavior: not 'false' = enabled. Tests legacy compat path.
      expect(src).toMatch(/BREAKOUT_REQUIRE_ROOM_JOINED\s*!==\s*['"]false['"]/);
    });

    it('uses roomParticipants when flag on AND map exists, else falls back to presenceMap', () => {
      expect(src).toMatch(/isConnectedFor/);
      const helperStart = src.indexOf('const isConnectedFor');
      const helperEnd = src.indexOf('\n    };', helperStart);
      const helper = src.slice(helperStart, helperEnd);
      expect(helper).toMatch(/activeSession\.roomParticipants/);
      expect(helper).toMatch(/activeSession\.presenceMap\.has\(uid\)/);
    });

    it('per-room participant entries call isConnectedFor (not presenceMap directly)', () => {
      // The 3 per-participant blocks in the rooms.map() must use the helper
      const dashStart = src.indexOf('const rooms = matches');
      const dashEnd = src.indexOf('// Find bye participants', dashStart);
      const block = src.slice(dashStart, dashEnd);
      // All three pushes use isConnectedFor
      const helperCalls = (block.match(/isConnectedFor\(/g) || []).length;
      expect(helperCalls).toBe(3);
    });
  });
});

describe('T0-2 — client side: VideoRoom emits presence:room_joined', () => {
  it('LiveKitRoom has an onConnected handler that emits presence:room_joined', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    expect(src).toMatch(/onConnected=\{\(\)\s*=>\s*\{[\s\S]*?presence:room_joined/);
  });

  it('payload includes sessionId, matchId, roomId', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    const onConnectIdx = src.indexOf('onConnected={() => {');
    const block = src.slice(onConnectIdx, onConnectIdx + 600);
    expect(block).toMatch(/sessionId,/);
    expect(block).toMatch(/matchId:\s*currentMatchId/);
    expect(block).toMatch(/roomId:\s*currentRoomId/);
  });

  it('subscribes currentMatchId from sessionStore', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    expect(src).toMatch(/const currentMatchId = useSessionStore\(s => s\.currentMatchId\)/);
  });
});
