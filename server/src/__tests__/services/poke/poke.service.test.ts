// ─── Poke Service — acceptance notification (F1) + message-less edge (F3) ────
//
// Task F1 (migration 081, notifications.type += 'poke_accepted'): acceptPoke
// notified NOBODY on the sender's side — only a silent fanoutUserEntity badge
// refresh from the route. This pins the new bell notification for the sender,
// inserted in the same transaction as the accept, pushed live only after
// commit (mirrors sendPoke's io.to(`user:{id}`).emit('notification:new', ...)
// + entity fanout pattern, server/src/services/poke/poke.service.ts L90-126).
//
// Task F3 (small): acceptPoke only seeded the poke's message as the first DM
// when non-empty — a bare accepted poke left a 0-message conversation that
// canMessage()'s grandfather clause (dm.service.ts L138-165) can never open,
// so the pair could never chat. Every accepted poke must now yield a
// conversation with >=1 message.
//
// Mocking convention follows the existing precedent for this exact dynamic-
// import emit pattern: server/src/__tests__/services/pod-join-request-notify.test.ts
// (mocks ../../db, ../../config/logger, ../../index, ../../realtime/emit;
// leaves the real ../../realtime/entities in place since E is pure string
// builders). Adjusted here for this file's one-deeper nesting (../../../).

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockEmit = jest.fn();
const mockTo = jest.fn((_room: string) => ({ emit: mockEmit }));

jest.mock('../../../index', () => ({
  io: { to: (room: string) => mockTo(room) },
  __esModule: true,
}));

const mockEmitEntities = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../services/block/block.service', () => ({
  areBlocked: async () => false,
  __esModule: true,
}));

// Task F2 — email layer is mocked entirely. Behaviour tests below assert
// poke.service's wiring (recipient/name/link) and gating; the actual
// subject-line rendering is pinned separately against the real
// email.service.ts source (see "F2 email templates" describe block).
const mockSendPokeReceivedEmail = jest.fn().mockResolvedValue(undefined);
const mockSendPokeAcceptedEmail = jest.fn().mockResolvedValue(undefined);
const mockIsEmailTypeEnabled = jest.fn().mockResolvedValue(true);

jest.mock('../../../services/email/email.service', () => ({
  sendPokeReceivedEmail: (...args: unknown[]) => mockSendPokeReceivedEmail(...args),
  sendPokeAcceptedEmail: (...args: unknown[]) => mockSendPokeAcceptedEmail(...args),
  isEmailTypeEnabled: (...args: unknown[]) => mockIsEmailTypeEnabled(...args),
  __esModule: true,
}));

import * as pokeService from '../../../services/poke/poke.service';
import config from '../../../config';

const SENDER = 'u-send';
const RECIPIENT = 'u-recv';
const ACCEPTER_NAME = 'Jamie Accepter';
const RESPONDED_AT = new Date('2026-07-23T12:00:00Z');
const NOTIF_CREATED_AT = new Date('2026-07-23T12:00:01Z');
const MESSAGES_URL = `${config.clientUrl}/messages`;

// Both email notifications are deliberately fire-and-forget (`void`, never
// awaited by sendPoke/acceptPoke) so a slow Resend call can never delay the
// response. Tests that observe the email mock must let that detached
// promise chain settle first — same pattern used for other fire-and-forget
// paths in this repo (e.g. enrichment.orchestrator.test.ts).
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Wires mockQuery to answer every statement acceptPoke's transaction issues,
 * in the order the service currently runs them (SELECT ... FOR UPDATE,
 * UPDATE user_pokes, INSERT encounter_history, INSERT dm_conversations,
 * INSERT direct_messages, UPDATE dm_conversations, SELECT accepter name,
 * INSERT notifications). Regex-routed (not positional) so re-ordering the
 * service's queries doesn't silently break these tests the way a strict
 * mockResolvedValueOnce queue would.
 */
const SENDER_EMAIL = 'sender@example.com';
const SENDER_DISPLAY_NAME = 'Sam Sender';

function armAccept(
  message: string | null,
  opts: {
    notifInsertImpl?: () => Promise<unknown>;
    senderNotifyEmail?: boolean;
    senderHasEmail?: boolean;
  } = {},
) {
  const senderNotifyEmail = opts.senderNotifyEmail ?? true;
  const senderHasEmail = opts.senderHasEmail ?? true;
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM user_pokes WHERE id/.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: 'poke-1', sender_id: SENDER, recipient_id: RECIPIENT,
          status: 'pending', message, responded_at: null, created_at: new Date('2026-07-20T00:00:00Z'),
        }],
      });
    }
    if (/UPDATE user_pokes SET status/.test(sql)) {
      return Promise.resolve({ rows: [{ responded_at: RESPONDED_AT }] });
    }
    if (/INSERT INTO dm_conversations/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'conv-9' }] });
    }
    if (/SELECT email, display_name, notify_email FROM users WHERE id/.test(sql)) {
      return Promise.resolve({
        rows: [{
          email: senderHasEmail ? SENDER_EMAIL : null,
          display_name: SENDER_DISPLAY_NAME,
          notify_email: senderNotifyEmail,
        }],
      });
    }
    if (/SELECT display_name FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ display_name: ACCEPTER_NAME }] });
    }
    if (/INSERT INTO notifications/.test(sql)) {
      if (opts.notifInsertImpl) return opts.notifInsertImpl();
      return Promise.resolve({ rows: [{ id: 'notif-accept-1', created_at: NOTIF_CREATED_AT }] });
    }
    // INSERT INTO encounter_history, INSERT INTO direct_messages,
    // UPDATE dm_conversations SET last_message_at — none of these are
    // asserted on their return shape.
    return Promise.resolve({ rows: [] });
  });
}

const RECIPIENT_EMAIL = 'recipient@example.com';
const RECIPIENT_DISPLAY_NAME = 'Rex Recipient';
const SENDER_NAME = 'Sam Sender'; // sender's display_name as looked up inside sendPoke

/**
 * Wires mockQuery for sendPoke's full success path: block check (mocked
 * module-level), encounter_history miss, recipient-exists check, the
 * user_pokes INSERT, the sender-name lookup for the bell notification, the
 * notifications INSERT, and the recipient email-gate lookup (Task F2).
 */
function armSend(
  message: string | null,
  opts: {
    notifInsertImpl?: () => Promise<unknown>;
    recipientNotifyEmail?: boolean;
    recipientHasEmail?: boolean;
  } = {},
) {
  const recipientNotifyEmail = opts.recipientNotifyEmail ?? true;
  const recipientHasEmail = opts.recipientHasEmail ?? true;
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM encounter_history/.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    if (/SELECT email, display_name, notify_email FROM users WHERE id/.test(sql)) {
      return Promise.resolve({
        rows: [{
          email: recipientHasEmail ? RECIPIENT_EMAIL : null,
          display_name: RECIPIENT_DISPLAY_NAME,
          notify_email: recipientNotifyEmail,
        }],
      });
    }
    if (/SELECT id FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ id: RECIPIENT }] });
    }
    if (/INSERT INTO user_pokes/.test(sql)) {
      return Promise.resolve({
        rows: [{
          id: 'poke-2', sender_id: SENDER, recipient_id: RECIPIENT, status: 'pending',
          message, responded_at: null, created_at: new Date('2026-07-23T10:00:00Z'),
        }],
      });
    }
    if (/SELECT display_name FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ display_name: SENDER_NAME }] });
    }
    if (/INSERT INTO notifications/.test(sql)) {
      if (opts.notifInsertImpl) return opts.notifInsertImpl();
      return Promise.resolve({ rows: [{ id: 'notif-poke-1', created_at: new Date('2026-07-23T10:00:01Z') }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockEmit.mockClear();
  mockTo.mockClear();
  mockEmitEntities.mockClear();
  mockSendPokeReceivedEmail.mockClear();
  mockSendPokeAcceptedEmail.mockClear();
  mockIsEmailTypeEnabled.mockReset().mockResolvedValue(true);
});

describe('acceptPoke — F1 acceptance notification for the sender', () => {
  it('inserts a poke_accepted notification for the SENDER, titled with the accepter\'s name, linking to /messages', async () => {
    armAccept('You fit what they want. We think you two should meet.');

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const notifCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && /INSERT INTO notifications/.test(c[0] as string),
    );
    expect(notifCall).toBeDefined();
    expect(notifCall![0]).toMatch(/'poke_accepted'/);
    expect(notifCall![0]).toMatch(/'\/messages'/);
    const params = notifCall![1] as unknown[];
    // user_id (notification recipient) is the SENDER of the poke, not the accepter.
    expect(params).toContain(SENDER);
    expect(params).toContain(`${ACCEPTER_NAME} accepted your meeting request`);
  });

  it('body is the first ~120 chars of the intro message', async () => {
    const longMessage = 'A'.repeat(200);
    armAccept(longMessage);

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const notifCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && /INSERT INTO notifications/.test(c[0] as string),
    );
    const params = notifCall![1] as string[];
    const body = params.find(p => typeof p === 'string' && p.startsWith('A'))!;
    expect(body.length).toBeLessThanOrEqual(120);
  });

  it('body is empty-safe: a message-less poke falls back to the seeded first-message text', async () => {
    armAccept(null);

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const notifCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && /INSERT INTO notifications/.test(c[0] as string),
    );
    const params = notifCall![1] as string[];
    expect(params).toContain("You're connected. Say hello.");
  });

  it('emits notification:new to the SENDER\'s user room only after the transaction resolves', async () => {
    armAccept('Hello there');

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    expect(mockTo).toHaveBeenCalledWith(`user:${SENDER}`);
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({
      type: 'poke_accepted',
      title: `${ACCEPTER_NAME} accepted your meeting request`,
      link: '/messages',
      isRead: false,
      id: 'notif-accept-1',
    }));
  });

  it('also fans out the userNotifications + userInvites entity tags for the sender', async () => {
    armAccept('Hello there');

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    expect(mockEmitEntities).toHaveBeenCalledWith(
      expect.anything(),
      [SENDER],
      expect.arrayContaining([`user:${SENDER}:notifications`, `user:${SENDER}:invites`]),
    );
  });

  it('never emits a socket notification when the transaction fails partway through (no dangling push for a rolled-back tx)', async () => {
    armAccept('Hello there', { notifInsertImpl: () => Promise.reject(new Error('db down mid-tx')) });

    await expect(pokeService.acceptPoke('poke-1', RECIPIENT)).rejects.toThrow('db down mid-tx');

    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a non-recipient caller is rejected before any notification or message work happens', async () => {
    armAccept('Hello there');

    await expect(pokeService.acceptPoke('poke-1', 'u-stranger')).rejects.toMatchObject({ statusCode: 403 });

    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockTo).not.toHaveBeenCalled();
  });
});

describe('acceptPoke — F2 email notification to the sender', () => {
  it('emails the sender with their email, display name, accepter name, and the /messages link', async () => {
    armAccept('Hello there');

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).toHaveBeenCalledWith(
      SENDER_EMAIL,
      SENDER_DISPLAY_NAME,
      expect.objectContaining({
        accepterName: ACCEPTER_NAME,
        messagesUrl: MESSAGES_URL,
      }),
    );
  });

  it('suppresses the email when the sender has notify_email = false', async () => {
    armAccept('Hello there', { senderNotifyEmail: false });

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });

  it('suppresses the email when the sender has no email on file', async () => {
    armAccept('Hello there', { senderHasEmail: false });

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });

  it('suppresses the email when the email_config kill-switch is off for poke_accepted', async () => {
    armAccept('Hello there');
    mockIsEmailTypeEnabled.mockResolvedValue(false);

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockIsEmailTypeEnabled).toHaveBeenCalledWith('poke_accepted');
    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });

  it('never fails acceptPoke when the email send rejects (non-blocking, fire-and-forget)', async () => {
    armAccept('Hello there');
    mockSendPokeAcceptedEmail.mockRejectedValueOnce(new Error('resend down'));

    const result = await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(result.poke.status).toBe('accepted');
  });

  it('never sends the email when the transaction fails partway through (mirrors the F1 emit-ordering guarantee)', async () => {
    armAccept('Hello there', { notifInsertImpl: () => Promise.reject(new Error('db down mid-tx')) });

    await expect(pokeService.acceptPoke('poke-1', RECIPIENT)).rejects.toThrow('db down mid-tx');
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });
});

describe('acceptPoke — F3 message-less poke edge', () => {
  it('a poke WITH a message still seeds it as the first thread message from the sender (unchanged)', async () => {
    armAccept('You fit what they want. We think you two should meet.');

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const dmInsert = mockQuery.mock.calls.find(c => /INSERT INTO direct_messages/.test(c[0] as string));
    expect(dmInsert).toBeTruthy();
    const params = dmInsert![1] as string[];
    expect(params[1]).toBe('conv-9');
    expect(params[2]).toBe(SENDER);
    expect(params[3]).toMatch(/should meet/);
  });

  it('a message-less poke seeds the fallback "You\'re connected. Say hello." authored by the sender', async () => {
    armAccept(null);

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const dmInsert = mockQuery.mock.calls.find(c => /INSERT INTO direct_messages/.test(c[0] as string));
    expect(dmInsert).toBeTruthy();
    const params = dmInsert![1] as string[];
    expect(params[1]).toBe('conv-9');
    expect(params[2]).toBe(SENDER);
    expect(params[3]).toBe("You're connected. Say hello.");
  });

  it('a message-less poke still bumps last_message_at so the thread surfaces in the inbox', async () => {
    armAccept(null);

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    expect(mockQuery.mock.calls.some(c => /UPDATE dm_conversations SET last_message_at/.test(c[0] as string))).toBe(true);
  });
});

describe('declinePoke — still notifies nobody', () => {
  function armDecline() {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM user_pokes WHERE id/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 'poke-1', sender_id: SENDER, recipient_id: RECIPIENT,
            status: 'pending', message: 'hi', responded_at: null, created_at: new Date('2026-07-20T00:00:00Z'),
          }],
        });
      }
      if (/UPDATE user_pokes SET status/.test(sql)) {
        return Promise.resolve({ rows: [{ responded_at: RESPONDED_AT }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('declining inserts no notification and pushes no socket event', async () => {
    armDecline();

    const result = await pokeService.declinePoke('poke-1', RECIPIENT);

    expect(result.status).toBe('declined');
    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });
});

describe('sendPoke — F2 email notification to the recipient', () => {
  it('emails the recipient with their email, display name, sender name, the intro message, and the /messages link', async () => {
    armSend('Would love to connect and swap notes.');

    await pokeService.sendPoke(SENDER, RECIPIENT, 'Would love to connect and swap notes.');
    await flushPromises();

    expect(mockSendPokeReceivedEmail).toHaveBeenCalledWith(
      RECIPIENT_EMAIL,
      RECIPIENT_DISPLAY_NAME,
      expect.objectContaining({
        senderName: SENDER_NAME,
        introMessage: 'Would love to connect and swap notes.',
        messagesUrl: MESSAGES_URL,
      }),
    );
  });

  it('passes introMessage: null for a message-less poke', async () => {
    armSend(null);

    await pokeService.sendPoke(SENDER, RECIPIENT);
    await flushPromises();

    expect(mockSendPokeReceivedEmail).toHaveBeenCalledWith(
      RECIPIENT_EMAIL,
      RECIPIENT_DISPLAY_NAME,
      expect.objectContaining({ introMessage: null }),
    );
  });

  it('suppresses the email when the recipient has notify_email = false', async () => {
    armSend('hi', { recipientNotifyEmail: false });

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });

  it('suppresses the email when the recipient has no email on file', async () => {
    armSend('hi', { recipientHasEmail: false });

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });

  it('suppresses the email when the email_config kill-switch is off for poke_request', async () => {
    armSend('hi');
    mockIsEmailTypeEnabled.mockResolvedValue(false);

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockIsEmailTypeEnabled).toHaveBeenCalledWith('poke_request');
    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });

  it('never fails sendPoke when the email send rejects (non-blocking, fire-and-forget)', async () => {
    armSend('hi');
    mockSendPokeReceivedEmail.mockRejectedValueOnce(new Error('resend down'));

    const result = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(result.status).toBe('pending');
  });

  it('never sends the email when the bell-notification insert fails (mirrors the existing non-fatal notif-insert guarantee)', async () => {
    armSend('hi', { notifInsertImpl: () => Promise.reject(new Error('db down mid-notify')) });

    const result = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    // sendPoke still succeeds — the bell notification (and its email
    // sibling) are best-effort, exactly like the pre-existing notifErr catch.
    expect(result.status).toBe('pending');
    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });
});

describe('email.service.ts — F2 poke email templates + kill-switch', () => {
  const fsMod: typeof import('fs') = require('fs');
  const pathMod: typeof import('path') = require('path');
  const src: string = fsMod.readFileSync(
    pathMod.join(__dirname, '../../../services/email/email.service.ts'), 'utf8',
  );

  it('sendPokeReceivedEmail subject is "{senderName} wants to meet you on RSN" (plain, matching the house style)', () => {
    const i = src.indexOf('export async function sendPokeReceivedEmail(');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport async function ', i + 1));
    expect(fn).toMatch(/subject = `\$\{data\.senderName\} wants to meet you on RSN`/);
    expect(fn).toMatch(/data\.messagesUrl/);
    expect(fn).toMatch(/escapeHtml\(data\.introMessage\)/);
  });

  it('sendPokeAcceptedEmail subject is "{accepterName} accepted your meeting request"', () => {
    const i = src.indexOf('export async function sendPokeAcceptedEmail(');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport async function ', i + 1));
    expect(fn).toMatch(/subject = `\$\{data\.accepterName\} accepted your meeting request`/);
    expect(fn).toMatch(/data\.messagesUrl/);
  });

  it('isEmailTypeEnabled queries email_config by email_type and fails open on a missing row', () => {
    const i = src.indexOf('export async function isEmailTypeEnabled(');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport async function ', i + 1));
    expect(fn).toMatch(/FROM email_config WHERE email_type/);
    expect(fn).toMatch(/rows\.length === 0 \? true/);
  });
});
