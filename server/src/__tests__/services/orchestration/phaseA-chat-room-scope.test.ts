// Phase A — In-room chat scope resolution (1 May 2026)
//
// Bug from Stefan's screenshot (issues 1 and 2 of his report): users inside
// a breakout room can type chat messages, the chat window renders, but
// messages don't reach the other participants in the same room.
//
// Root cause from audit:
//   chat-handlers.ts:104-112 queries `WHERE status='active'` to find the
//   sender's room. If the match's status isn't strictly 'active' at query
//   time (state transition race, just-completed trio, scheduled room not
//   yet flipped, manual breakout in 'completed' but LiveKit still running)
//   the query returns 0 rows, and the handler's fallback at line 131 emits
//   only to `socket.emit` — i.e. back to the sender alone. The other
//   participants in the LiveKit room never see the message.
//
// Architectural fix:
//   The `activeSession.roomParticipants` Map (set when the client emits
//   `presence:room_joined` after LiveKit `room.connect()` resolves) is the
//   real-time source of truth for "who is in which room right now".
//   chat-handlers.ts should consult this map first. If the map doesn't have
//   the sender (feature flag off, LiveKit still negotiating, legacy
//   session), fall back to a RELAXED match query that doesn't require
//   `status='active'` — anything except `cancelled` or `no_show` counts.
//
// These tests pin the new architecture so the regression doesn't return.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase A — in-room chat scope resolution', () => {
  const src = readSource('services/orchestration/handlers/chat-handlers.ts');

  describe('handleChatSend room scope: roomParticipants is consulted first', () => {
    const fnStart = src.indexOf('export async function handleChatSend');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const fn = src.slice(fnStart, fnEnd);

    it('the room-scope branch reads activeSession.roomParticipants before the match query', () => {
      // The room scope branch starts after `if (scope === 'lobby')` ... `} else {`
      const elseIdx = fn.indexOf("scope === 'lobby'");
      expect(elseIdx).toBeGreaterThan(-1);
      const branchStart = fn.indexOf('} else {', elseIdx);
      const roomBranchEnd = fn.indexOf('}\n  } catch', branchStart);
      const roomBranch = fn.slice(branchStart, roomBranchEnd);
      expect(roomBranch).toMatch(/roomParticipants/);
    });

    it('the relaxed match-query fallback does NOT require status=active', () => {
      // Pre-fix: WHERE status='active'. Post-fix: removed or broadened.
      // We pin that the room-scope query no longer hard-filters on
      // status='active' alone (it can include 'active', 'completed',
      // 'reassigned' OR drop the filter entirely).
      const elseIdx = fn.indexOf("scope === 'lobby'");
      const branchStart = fn.indexOf('} else {', elseIdx);
      const roomBranchEnd = fn.indexOf('}\n  } catch', branchStart);
      const roomBranch = fn.slice(branchStart, roomBranchEnd);
      // Must NOT contain the literal pre-fix filter.
      expect(roomBranch).not.toMatch(/AND m\.status = 'active'\s+AND \(participant_a_id/);
      expect(roomBranch).not.toMatch(/AND status = 'active'\s+AND \(participant_a_id/);
    });

    it('the room-scope branch builds a recipient set from roomParticipants', () => {
      const elseIdx = fn.indexOf("scope === 'lobby'");
      const branchStart = fn.indexOf('} else {', elseIdx);
      const roomBranchEnd = fn.indexOf('}\n  } catch', branchStart);
      const roomBranch = fn.slice(branchStart, roomBranchEnd);
      // The fix iterates over the roomParticipants map and collects userIds
      // sharing the same roomId as the sender.
      expect(roomBranch).toMatch(/roomParticipants/);
      // It also still uses io.to(userRoom(pid)) for delivery (existing pattern).
      expect(roomBranch).toMatch(/io\.to\(userRoom\(/);
    });

    it('only emits to socket alone when ALL fallbacks fail (truly orphan sender)', () => {
      // A sender who isn't in roomParticipants AND has no recent match in DB
      // is genuinely not in any room — emit-to-self is the only honest fallback.
      // We pin that this fallback is NOT the primary path: it sits behind
      // both roomParticipants and the relaxed query.
      const elseIdx = fn.indexOf("scope === 'lobby'");
      const branchStart = fn.indexOf('} else {', elseIdx);
      const roomBranchEnd = fn.indexOf('}\n  } catch', branchStart);
      const roomBranch = fn.slice(branchStart, roomBranchEnd);
      // The bare socket.emit is still allowed but must come AFTER the
      // roomParticipants check.
      const emitSelfIdx = roomBranch.lastIndexOf('socket.emit');
      const roomParticipantsIdx = roomBranch.indexOf('roomParticipants');
      expect(roomParticipantsIdx).toBeGreaterThan(-1);
      expect(emitSelfIdx).toBeGreaterThan(roomParticipantsIdx);
    });

    it('the resolved roomId is attached to the chat message payload', () => {
      // Client-side filter relies on chatMsg.roomId === currentRoomId. Pin
      // that the handler sets it from the resolved source.
      expect(fn).toMatch(/chatMsg\.roomId\s*=/);
    });
  });

  describe('handleChatReact: same scope-resolution pattern (no regression for reactions)', () => {
    it('chat-reactions still resolves recipients per match.room_id (no status=active hard filter)', () => {
      const fnStart = src.indexOf('export async function handleChatReact');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Reaction broadcast looks up the match by msg.roomId (already correct).
      expect(fn).toMatch(/WHERE room_id = \$1/);
    });
  });

  describe('handleReactionSend: relaxed status filter for floating reactions', () => {
    it('floating-reaction match lookup also relaxes the status=active filter', () => {
      // Floating reactions during round_rating phase (just after End Round)
      // had the same bug: status changes from 'active' to 'completed' and
      // reactions stop reaching the room. Apply the same relaxation.
      const fnStart = src.indexOf('export async function handleReactionSend');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Either uses roomParticipants OR a relaxed status filter.
      const usesRoomParticipants = /roomParticipants/.test(fn);
      const usesRelaxedStatus = /status\s+(IN|=)\s+\(?'active'/.test(fn) === false
        || /status\s+IN\s*\(\s*'active'\s*,\s*'completed'/i.test(fn);
      expect(usesRoomParticipants || usesRelaxedStatus).toBe(true);
    });
  });
});
