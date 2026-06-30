// Phase 0 (1 May 2026 spec) — server-canonical room assignment
//
// Pre-fix: roomParticipants was populated only via client-emitted
// presence:room_joined after LiveKit room.connect resolved. If user A's
// LK connect completed before user B's, A's chat-send found A in the map
// but no other userId mapped to the same roomId, so the message routed
// only back to A. B's later presence:room_joined fixed it for the next
// message but the first one was lost.
//
// Fix: server-side helper setRoomAssignment(sessionId, matchId, roomId,
// userIds[]) is called at every match-activation site so roomParticipants
// reflects the assignment the moment the server hands out the LiveKit
// token. Client presence:room_joined remains as a confirmation but no
// longer races chat-send.
//
// This test pins the architectural rule: every code path that creates an
// ACTIVE match (auto round, manual host breakout, host force-reassign,
// host move-to-room, solo-recovery, disconnect-recovery) MUST call
// setRoomAssignment.

import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase 0 — server-canonical roomParticipants assignment', () => {
  describe('helper exists in participant-flow.ts', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('exports setRoomAssignment(sessionId, matchId, roomId, userIds)', () => {
      expect(src).toMatch(/export function setRoomAssignment\(\s*sessionId: string,\s*matchId: string,\s*roomId: string,\s*userIds:/);
    });

    it('writes to activeSession.roomParticipants', () => {
      const fnStart = src.indexOf('export function setRoomAssignment(');
      const fnEnd = src.indexOf('\n}', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/activeSession\.roomParticipants\.set/);
    });

    it('is idempotent (overwrites existing entries)', () => {
      const fnStart = src.indexOf('export function setRoomAssignment(');
      const fnEnd = src.indexOf('\n}', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Map.set inherently overwrites; assert no guard like `if (!has)`.
      expect(fn).not.toMatch(/if\s*\(\s*!\s*activeSession\.roomParticipants\.has/);
    });
  });

  describe('round-lifecycle.ts auto-round activates with assignment', () => {
    const src = readServer('services/orchestration/handlers/round-lifecycle.ts');

    it('imports and calls setRoomAssignment in the match-assigned loop', () => {
      // The loop sits between Step 6 marker and the partners.map emit.
      const loopStart = src.indexOf('Step 6: Emit match:assigned');
      const loopEnd = src.indexOf('Fire all status updates in parallel', loopStart);
      const loop = src.slice(loopStart, loopEnd);
      expect(loop).toMatch(/setRoomAssignment\(/);
    });

    it('calls setRoomAssignment BEFORE emitting match:assigned', () => {
      const loopStart = src.indexOf('Step 6: Emit match:assigned');
      const loopEnd = src.indexOf('Fire all status updates in parallel', loopStart);
      const loop = src.slice(loopStart, loopEnd);
      const setIdx = loop.indexOf('setRoomAssignment(');
      const emitIdx = loop.indexOf("emit('match:assigned'");
      expect(setIdx).toBeGreaterThan(-1);
      expect(emitIdx).toBeGreaterThan(-1);
      expect(setIdx).toBeLessThan(emitIdx);
    });
  });

  describe('breakout-bulk.ts manual host breakouts activate with assignment', () => {
    const src = readServer('services/orchestration/handlers/breakout-bulk.ts');

    it('calls setRoomAssignment after match INSERT for manual rooms', () => {
      const insertIdx = src.indexOf('INSERT INTO matches');
      const reassignedEmitIdx = src.indexOf("emit('match:reassigned'", insertIdx);
      const slice = src.slice(insertIdx, reassignedEmitIdx);
      expect(slice).toMatch(/setRoomAssignment\(/);
    });
  });

  describe('host-actions.ts host actions activate with assignment', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('host force-reassign single-pair calls setRoomAssignment', () => {
      // Find first INSERT INTO matches with status='active' and verify a
      // setRoomAssignment call follows in the same handler block.
      const firstInsert = src.indexOf("INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status, is_override)");
      expect(firstInsert).toBeGreaterThan(-1);
      const after = src.slice(firstInsert, firstInsert + 2000);
      expect(after).toMatch(/setRoomAssignment\(/);
    });

    it('host move-to-room calls setRoomAssignment', () => {
      const insertIdx = src.indexOf("INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, is_override)");
      expect(insertIdx).toBeGreaterThan(-1);
      // Phase 7-audit fix added the LiveKit cleanup catch block between the
      // INSERT and the setRoomAssignment call; widened from 1500 to 3000.
      const after = src.slice(insertIdx, insertIdx + 3000);
      expect(after).toMatch(/setRoomAssignment\(/);
    });

    it('host single-breakout (is_manual=TRUE) calls setRoomAssignment', () => {
      // Phase 4A (5 May spec) wrapped the INSERT in transaction() so
      // setRoomAssignment now lives in the post-transaction block. Widened
      // 2000 → 4000 for the transaction close + notification loop, then
      // 4000 → 5000 when the Ship A regression fix added the canonical
      // location clear for retired matches between them (4 Jun).
      const insertIdx = src.indexOf("INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, is_manual)");
      expect(insertIdx).toBeGreaterThan(-1);
      const after = src.slice(insertIdx, insertIdx + 5000);
      expect(after).toMatch(/setRoomAssignment\(/);
    });
  });

  describe('participant-flow.ts recovery flows activate with assignment', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('WS2 — participant-flow no longer creates matches at all (recovery INSERTs removed)', () => {
      // Pre-WS2 the solo-recovery (leave) and disconnect-recovery flows
      // INSERTed new active matches here, and this test pinned that every
      // such INSERT was followed by setRoomAssignment. WS2 (27 May
      // remaining work) removed re-pairing entirely — a room dropping
      // below 2 ends for the survivor — so the architectural rule is now
      // simpler and stronger: participant-flow NEVER creates matches.
      // Match creation (and its setRoomAssignment pairing, pinned by the
      // matching-flow/host-actions cases above) happens only in the
      // matching engine and host actions.
      expect(src).not.toMatch(/INSERT INTO matches/);
    });
  });

  describe('chat-handlers.ts continues to use roomParticipants as primary source', () => {
    const src = readServer('services/orchestration/handlers/chat-handlers.ts');

    it('handleChatSend room scope reads roomParticipants first, DB second', () => {
      const fnStart = src.indexOf('export async function handleChatSend(');
      const fnEnd = src.indexOf('\n}', fnStart + 100);
      const fn = src.slice(fnStart, fnEnd);
      const roomMapIdx = fn.indexOf('roomParticipants?.get(userId)');
      // Phase 8A.4 tightened the fallback from 'NOT IN (cancelled,
      // no_show)' to 'IN (active, scheduled)'. Either form is fine —
      // what we're pinning is that the fallback comes AFTER the
      // in-memory primary read.
      const fallbackIdx = fn.indexOf("status IN ('active', 'scheduled')");
      expect(roomMapIdx).toBeGreaterThan(-1);
      expect(fallbackIdx).toBeGreaterThan(-1);
      expect(roomMapIdx).toBeLessThan(fallbackIdx);
    });
  });

  describe('clearRoomParticipantsForMatch still cleans up on terminal status', () => {
    const src = readServer('services/orchestration/handlers/participant-flow.ts');

    it('still exists (called when match flips to terminal)', () => {
      expect(src).toMatch(/export function clearRoomParticipantsForMatch/);
    });
  });
});
