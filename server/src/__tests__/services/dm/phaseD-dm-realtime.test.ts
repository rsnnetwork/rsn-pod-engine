// Phase D — DM real-time + notifications + offline email (1 May 2026)
//
// Pins the architecture:
//   1. dm-handlers.ts exports handleDmSend, handleDmRead.
//   2. handleDmSend emits dm:message to BOTH users' rooms (sender + recipient).
//   3. handleDmSend emits dm:conversation_updated to both users for inbox sort.
//   4. handleDmSend writes a notifications row with type='direct_message'
//      and emits notification:new (existing bell pattern).
//   5. handleDmSend triggers email when recipient is offline (no socket
//      in their userRoom), debounced via Redis 1 hour TTL.
//   6. handleDmRead emits dm:read_receipt to the OTHER user (sender side).
//   7. orchestration.service.ts wires both handlers on dm:send and dm:read.
//   8. email.service.ts has sendDmNotificationEmail with snippet + thread URL.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase D — DM real-time + notifications', () => {
  describe('dm-handlers.ts surface', () => {
    const src = readServer('services/orchestration/handlers/dm-handlers.ts');

    it('exports handleDmSend and handleDmRead', () => {
      expect(src).toMatch(/export async function handleDmSend\(/);
      expect(src).toMatch(/export async function handleDmRead\(/);
    });

    it('handleDmSend emits dm:message to BOTH users\' rooms', () => {
      const fnStart = src.indexOf('export async function handleDmSend(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const emits = (fn.match(/io\.to\(userRoom\([^)]+\)\)\.emit\(['"]dm:message['"]/g) || []).length;
      expect(emits).toBeGreaterThanOrEqual(2);
    });

    it('handleDmSend emits dm:conversation_updated for inbox sort', () => {
      const fnStart = src.indexOf('export async function handleDmSend(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/dm:conversation_updated/);
    });

    it('handleDmSend writes a notifications row with type=direct_message', () => {
      const fnStart = src.indexOf('export async function handleDmSend(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/INSERT INTO notifications[\s\S]+?'direct_message'/);
    });

    it('handleDmSend emits notification:new (bell badge integration)', () => {
      const fnStart = src.indexOf('export async function handleDmSend(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/notification:new/);
    });

    it('handleDmSend checks recipient online status via fetchSockets', () => {
      const fnStart = src.indexOf('async function isUserOnline');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/fetchSockets/);
    });

    it('email path is debounced via Redis with hourly TTL', () => {
      // Constants for the debounce key + TTL
      expect(src).toMatch(/DM_EMAIL_DEBOUNCE_TTL_SECONDS\s*=\s*3600/);
      expect(src).toMatch(/dm:email-debounce:/);
    });

    it('email send is fire-and-forget (void maybeSendDmEmail)', () => {
      // We never want the socket response to block on email I/O.
      const fnStart = src.indexOf('export async function handleDmSend(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/void maybeSendDmEmail/);
    });

    it('handleDmRead emits dm:read_receipt to the OTHER user', () => {
      const fnStart = src.indexOf('export async function handleDmRead(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/dm:read_receipt/);
      expect(fn).toMatch(/otherUserId/);
    });
  });

  describe('orchestration.service.ts wires DM handlers', () => {
    const src = readServer('services/orchestration/orchestration.service.ts');

    it('imports handleDmSend and handleDmRead from dm-handlers', () => {
      // Phase E (3 May) added handleDmReact + handleDmUnreact to the same
      // import line. The pin only requires that the two Phase D handlers are
      // among the imports from dm-handlers, regardless of what else is there.
      expect(src).toMatch(/import \{[^}]*\bhandleDmSend\b[^}]*\bhandleDmRead\b[^}]*\} from ['"]\.\/handlers\/dm-handlers['"]/);
    });

    it('registers socket.on(dm:send)', () => {
      expect(src).toMatch(/socket\.on\(['"]dm:send['"]/);
    });

    it('registers socket.on(dm:read)', () => {
      expect(src).toMatch(/socket\.on\(['"]dm:read['"]/);
    });
  });

  describe('email.service.ts has DM notification email', () => {
    const src = readServer('services/email/email.service.ts');

    it('exports sendDmNotificationEmail', () => {
      expect(src).toMatch(/export async function sendDmNotificationEmail\(/);
    });

    it('email body includes the snippet and a thread link', () => {
      const fnStart = src.indexOf('export async function sendDmNotificationEmail(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/data\.snippet/);
      expect(fn).toMatch(/data\.threadUrl/);
    });

    it('subject includes the sender name', () => {
      const fnStart = src.indexOf('export async function sendDmNotificationEmail(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/subject = `\$\{data\.senderName\} sent you a message/);
    });
  });
});
