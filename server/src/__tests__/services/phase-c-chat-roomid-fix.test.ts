// Phase C — chat fix (10 May review items 13, 14).
//
// Pins the architectural fact that breakout chat keys on the LiveKit room
// id, not the DB match-record UUID. Pre-fix, the server emitted chat:message
// with `roomId = LiveKit room id` and the client filtered by `currentMatchId`
// (DB match UUID). Different identifier spaces — the filter NEVER matched
// and breakout chat was silently invisible (Stefan #13).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase C — chat: breakout filter keys on LiveKit room id', () => {
  describe('client ChatPanel filters on currentRoomId', () => {
    const src = readClient('features/live/ChatPanel.tsx');

    it('reads currentRoomId from the store', () => {
      expect(src).toMatch(/const\s+currentRoomId\s*=\s*useSessionStore\(s\s*=>\s*s\.currentRoomId\)/);
    });

    it('does NOT read currentMatchId for chat filtering', () => {
      // currentMatchId may still be referenced for other things (e.g. requesting
      // chat history) but must not be the filter key.
      const filterMatch = src.match(/const\s+visibleMessages\s*=\s*chatMessages\.filter[\s\S]*?\}\);/);
      expect(filterMatch).toBeTruthy();
      expect(filterMatch![0]).not.toMatch(/currentMatchId/);
      expect(filterMatch![0]).toMatch(/msg\.roomId\s*===\s*currentRoomId/);
    });
  });

  describe('client useSessionSocket captures room id on match:reassigned too', () => {
    const src = readClient('hooks/useSessionSocket.ts');

    it('match:reassigned handler calls store.setRoomId(data.roomId)', () => {
      const reassignStart = src.indexOf("socket.on('match:reassigned'");
      expect(reassignStart).toBeGreaterThan(-1);
      const reassignEnd = src.indexOf("socket.on('match:partner_disconnected'", reassignStart);
      const reassignBlock = src.slice(reassignStart, reassignEnd);
      expect(reassignBlock).toMatch(/store\.setRoomId\(data\.roomId\)/);
    });

    it('match:assigned handler still calls store.setRoomId(data.roomId)', () => {
      const assignStart = src.indexOf("socket.on('match:assigned'");
      expect(assignStart).toBeGreaterThan(-1);
      const assignEnd = src.indexOf("socket.on('match:reassigned'", assignStart);
      const assignBlock = src.slice(assignStart, assignEnd);
      expect(assignBlock).toMatch(/store\.setRoomId\(data\.roomId\)/);
    });
  });

  describe('server still emits roomId on chat:message', () => {
    const src = readServer('services/orchestration/handlers/chat-handlers.ts');

    it('chat-handlers stamps chatMsg.roomId before emitting to recipients', () => {
      // The server-side fact the client filter relies on: messages have a
      // roomId field set to the LiveKit room id. If this regresses, breakout
      // chat goes invisible again because the new filter has nothing to match.
      expect(src).toMatch(/chatMsg\.roomId\s*=\s*resolvedRoomId/);
    });
  });
});
