// ─── Phase 4 + 5 — Atomic room ops, chat reliability, error toasts, test mode ──
//
// Pins the architectural surfaces shipped together in Phase 4 + 5:
//
//   4A — handleHostCreateBreakout wraps Step 1 (reassign existing matches)
//        and Step 3 (insert new manual match) in a single transaction.
//        LiveKit room creation runs FIRST (fail-fast). Notifications run
//        AFTER the transaction commits so we never emit "your partner
//        left" for a reassignment that was rolled back.
//
//   4B — chat:request_history socket event force-fetches authoritative
//        chat history on demand. ChatPanel emits this on mount so a
//        message that was missed locally (race / disconnect / scope) is
//        recovered when the panel opens.
//
//   5A — error: socket events fire toasts via useToastStore with code-
//        specific friendly text. Critical errors also keep the legacy
//        banner; warnings/info are toast-only.
//
//   5B — testMode flag in session-state-snapshot. Heuristic detection:
//        if 2+ non-host participants share the host's email-username
//        root (length ≥ 4 chars), flag testMode=true. Honours explicit
//        session.config.testMode override. Surface in session:state
//        socket payload; client renders TestModeBanner.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

describe('Phase 4 + 5 — Atomic room ops, chat reliability, error toasts, test mode', () => {
  describe('Sub-phase 4A — atomic create-breakout', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('handleHostCreateBreakout wraps reassign + insert in a single transaction', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/await transaction\(async \(client\)/);
      // Both writes are inside the transaction — client.query rather than query.
      expect(fn).toMatch(/client\.query\(\s*`?UPDATE matches SET status = 'reassigned'/);
      expect(fn).toMatch(/client\.query\(\s*`?INSERT INTO matches/);
    });

    it('LiveKit room creation runs BEFORE the transaction (fail-fast)', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      const liveKitIdx = fn.indexOf('videoService.createMatchRoom(');
      const transactionIdx = fn.indexOf('await transaction(async (client)');
      expect(liveKitIdx).toBeGreaterThan(-1);
      expect(transactionIdx).toBeGreaterThan(-1);
      expect(liveKitIdx).toBeLessThan(transactionIdx);
    });

    it('partner-disconnected emit happens AFTER the transaction commits', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      // Find the closing of the transaction (\n      });) and verify the
      // notification loop sits AFTER it — no emit inside the transaction.
      const transactionStart = fn.indexOf('await transaction(async (client)');
      const transactionEnd = fn.indexOf('});', transactionStart);
      const insideTx = fn.slice(transactionStart, transactionEnd);
      expect(insideTx).not.toMatch(/match:partner_disconnected/);
      const afterTx = fn.slice(transactionEnd);
      expect(afterTx).toMatch(/match:partner_disconnected/);
    });

    it('catch block surfaces PARTICIPANT_ALREADY_MATCHED on unique-violation rollback', () => {
      const fnStart = src.indexOf('export async function handleHostCreateBreakout(');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/PARTICIPANT_ALREADY_MATCHED/);
      expect(fn).toMatch(/MATCH_CREATION_FAILED/);
    });
  });

  describe('Sub-phase 4B — chat history force-fetch', () => {
    const handlerSrc = readServer('services/orchestration/handlers/chat-handlers.ts');
    const orchestrationSrc = readServer('services/orchestration/orchestration.service.ts');
    const panelSrc = readClient('features/live/ChatPanel.tsx');

    it('chat-handlers.ts exports handleChatRequestHistory', () => {
      expect(handlerSrc).toMatch(/export async function handleChatRequestHistory\(/);
    });

    it('orchestration.service.ts wires socket.on(chat:request_history)', () => {
      expect(orchestrationSrc).toMatch(/socket\.on\(['"]chat:request_history['"]/);
      expect(orchestrationSrc).toMatch(/handleChatRequestHistory/);
    });

    it('ChatPanel emits chat:request_history on mount', () => {
      expect(panelSrc).toMatch(/socket\.emit\(['"]chat:request_history['"][^\)]*sessionId/);
    });

    it('handler scopes room messages to the requesting user\'s matchId', () => {
      const fnStart = handlerSrc.indexOf('export async function handleChatRequestHistory(');
      const fnEnd = handlerSrc.indexOf('\n}\n', fnStart);
      const fn = handlerSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/m\.scope\s*===\s*['"]room['"]/);
      expect(fn).toMatch(/data\.matchId/);
    });
  });

  describe('Sub-phase 5A — error toast surface with code-specific text', () => {
    const src = readClient('hooks/useSessionSocket.ts');

    it('imports useToastStore', () => {
      expect(src).toMatch(/from\s+['"]@\/stores\/toastStore['"]/);
    });

    it('error listener fires useToastStore.addToast with friendly mapping', () => {
      const startIdx = src.indexOf("socket.on('error',");
      expect(startIdx).toBeGreaterThan(-1);
      const slice = src.slice(startIdx, startIdx + 3000);
      expect(slice).toMatch(/useToastStore\.getState\(\)\.addToast/);
      expect(slice).toMatch(/FRIENDLY/);
    });

    it('maps known error codes to specific copy', () => {
      const codes = [
        'ROOM_CREATION_FAILED',
        'MATCH_CREATION_FAILED',
        'PARTICIPANT_ALREADY_MATCHED',
        'GENERATE_FAILED',
        'NO_ELIGIBLE_PAIRS',
      ];
      for (const code of codes) {
        expect(src).toContain(`${code}:`);
      }
    });

    it('unrecognised codes fall through to the raw server message', () => {
      const startIdx = src.indexOf("socket.on('error',");
      const slice = src.slice(startIdx, startIdx + 3000);
      expect(slice).toMatch(/FRIENDLY\[code\]\s*\|\|\s*\{\s*msg:\s*rawMsg/);
    });
  });

  describe('Sub-phase 5B — test-mode detection + banner', () => {
    const snapshotSrc = readServer('services/session/session-state-snapshot.service.ts');
    const flowSrc = readServer('services/orchestration/handlers/participant-flow.ts');
    const liveSrc = readClient('features/live/LiveSessionPage.tsx');

    it('snapshot interface declares testMode boolean', () => {
      expect(snapshotSrc).toMatch(/testMode:\s*boolean/);
    });

    it('explicit session.config.testMode override wins', () => {
      const fnStart = snapshotSrc.indexOf('export async function buildSessionStateSnapshot(');
      const fnEnd = snapshotSrc.indexOf('\n}\n', fnStart);
      const fn = snapshotSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/typeof\s+\(config\s+as\s+any\)\.testMode\s*===\s*['"]boolean['"]/);
    });

    it('heuristic counts non-host participants matching the host on root/domain/name and triggers at 2+', () => {
      // Phase 7C.3 (7 May spec) replaced the v1 heuristic — dropped the
      // hostRoot.length >= 4 gate (false negatives for short real names)
      // and added two new signals: email domain match and display-name
      // first-name token match. Pin: hostRoot is computed and the 2+
      // threshold remains.
      const fnStart = snapshotSrc.indexOf('export async function buildSessionStateSnapshot(');
      const fnEnd = snapshotSrc.indexOf('\n}\n', fnStart);
      const fn = snapshotSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/hostRoot/);
      expect(fn).toMatch(/matches\s*>=\s*2/);
    });

    it('session:state emit propagates testMode to client', () => {
      const emitIdx = flowSrc.indexOf("socket.emit('session:state'");
      expect(emitIdx).toBeGreaterThan(-1);
      const slice = flowSrc.slice(emitIdx, emitIdx + 2000);
      expect(slice).toMatch(/testMode:\s*snapshot\.testMode/);
    });

    it('LiveSessionPage renders TestModeBanner', () => {
      expect(liveSrc).toMatch(/<TestModeBanner\s*\/>/);
      expect(liveSrc).toMatch(/function TestModeBanner\(\)/);
      expect(liveSrc).toMatch(/Test mode/i);
    });

    it('TestModeBanner reads testMode from sessionStore', () => {
      const fnStart = liveSrc.indexOf('function TestModeBanner()');
      const fnEnd = liveSrc.indexOf('\nfunction ', fnStart + 1);
      const fn = liveSrc.slice(fnStart, fnEnd);
      expect(fn).toMatch(/useSessionStore\(s\s*=>\s*s\.testMode\)/);
    });
  });
});
