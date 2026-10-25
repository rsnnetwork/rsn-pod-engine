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
type MockClient = { query: (...args: unknown[]) => unknown };
// A test that needs a transaction to roll back (the request world below) sets this;
// every other test gets the plain pass-through. Read at call time, so it can change per test.
let mockTransactionHook: ((cb: (client: MockClient) => unknown) => unknown) | null = null;

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: MockClient) => unknown) =>
    (mockTransactionHook ? mockTransactionHook(cb) : cb({ query: mockQuery })),
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

const mockAreBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...args: unknown[]) => mockAreBlocked(...args),
  __esModule: true,
}));

// 7 Sep 2026 — acceptPoke must fan the new conversation out to BOTH inboxes
// (pre-fix only the sender's bell fired, so the sender's Messages list never
// gained the conversation until a manual refresh). Routed through
// broadcastDmMessage with notify:false so no duplicate DM bell is added on top
// of the poke_accepted bell.
const mockBroadcastDm = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  broadcastDmMessage: (...args: unknown[]) => mockBroadcastDm(...args),
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

// pokes-notification-prefs (23 Jul 2026) — the Settings "Pokes" bell/email
// toggles. Mocked at the service boundary (same convention as email.service
// above) so gating tests can flip poke_bell/poke_email independently of the
// global notify_email + email_config gates, which stay wired through
// mockQuery/mockIsEmailTypeEnabled untouched.
const mockShouldSendEmail = jest.fn().mockResolvedValue(true);
const mockShouldSendBell = jest.fn().mockResolvedValue(true);

jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendEmail: (...args: unknown[]) => mockShouldSendEmail(...args),
  shouldSendBell: (...args: unknown[]) => mockShouldSendBell(...args),
  __esModule: true,
}));

import * as pokeService from '../../../services/poke/poke.service';
import { REQUEST_MESSAGE_MAX } from '../../../services/poke/request-message';
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
 * Wires mockQuery to answer every statement acceptPoke's transaction issues:
 * the claim (UPDATE user_pokes ... WHERE id = $1 AND recipient_id = $2 AND
 * status = 'pending' RETURNING ...), the sender's status, INSERT
 * encounter_history, INSERT dm_conversations, INSERT direct_messages, UPDATE
 * dm_conversations, the request the other way (none here), SELECT accepter
 * name, INSERT notifications, UPDATE notifications (the bell row read).
 * Regex-routed (not positional) so re-ordering the service's queries doesn't
 * silently break these tests the way a strict mockResolvedValueOnce queue would.
 * The claim answers the way the database does: only a request that is still
 * pending and was sent to this member is changed and returned.
 */
const SENDER_EMAIL = 'sender@example.com';
const SENDER_DISPLAY_NAME = 'Sam Sender';

function armAccept(
  message: string | null,
  opts: {
    notifInsertImpl?: () => Promise<unknown>;
    senderNotifyEmail?: boolean;
    senderHasEmail?: boolean;
    preferredFormat?: string | null;
  } = {},
) {
  const senderNotifyEmail = opts.senderNotifyEmail ?? true;
  const senderHasEmail = opts.senderHasEmail ?? true;
  const request = {
    id: 'poke-1', sender_id: SENDER, recipient_id: RECIPIENT,
    status: 'pending', message, responded_at: null as Date | null, created_at: new Date('2026-07-20T00:00:00Z'),
    preferred_format: opts.preferredFormat ?? null,
  };
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/UPDATE user_pokes[\s\S]*WHERE id = \$1/.test(sql)) {
      if (request.status !== 'pending' || params[1] !== request.recipient_id) return Promise.resolve({ rows: [] });
      request.status = params[2] as string;
      request.responded_at = RESPONDED_AT;
      return Promise.resolve({ rows: [{ ...request }] });
    }
    if (/FROM user_pokes WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ ...request }] });
    }
    if (/SELECT status FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ status: 'active' }] });
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
    if (/INSERT INTO direct_messages/.test(sql)) {
      // acceptPoke now RETURNs the seeded intro row so it can broadcast it.
      return Promise.resolve({ rows: [{
        id: 'dm-intro-1', conversation_id: 'conv-9', from_user_id: SENDER,
        content: message ?? "You're connected. Say hello.", read_at: null,
        created_at: new Date('2026-07-20T00:00:01Z'),
        attachment_url: null, attachment_type: null, attachment_meta: null,
      }] });
    }
    // INSERT INTO encounter_history, UPDATE dm_conversations SET
    // last_message_at — none of these are asserted on their return shape.
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
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
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
      // Answer the way the database does: only the columns named in RETURNING
      // come back, and preferred_format is whatever the INSERT wrote ($6). A
      // query that forgets to RETURN the format therefore shows up as null.
      const returned = (/RETURNING\s+([\s\S]+)$/i.exec(sql)?.[1] ?? '').split(',').map(column => column.trim());
      const row: Record<string, unknown> = {
        id: 'poke-2', sender_id: SENDER, recipient_id: RECIPIENT, status: 'pending',
        message, responded_at: null, created_at: new Date('2026-07-23T10:00:00Z'),
        preferred_format: params[5],
      };
      return Promise.resolve({
        rows: [Object.fromEntries(Object.entries(row).filter(([column]) => returned.includes(column)))],
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
  mockTransactionHook = null;
  mockAreBlocked.mockReset().mockResolvedValue(false);
  mockEmit.mockClear();
  mockTo.mockClear();
  mockEmitEntities.mockReset().mockResolvedValue(undefined);
  mockBroadcastDm.mockReset().mockResolvedValue(undefined);
  mockSendPokeReceivedEmail.mockClear();
  mockSendPokeAcceptedEmail.mockClear();
  mockIsEmailTypeEnabled.mockReset().mockResolvedValue(true);
  mockShouldSendEmail.mockReset().mockResolvedValue(true);
  mockShouldSendBell.mockReset().mockResolvedValue(true);
});

describe('acceptPoke — F1 acceptance notification for the sender', () => {
  it('inserts a poke_accepted notification for the SENDER, titled with the accepter\'s name, linking to the conversation', async () => {
    armAccept('You fit what they want. We think you two should meet.');

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    const notifCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && /INSERT INTO notifications/.test(c[0] as string),
    );
    expect(notifCall).toBeDefined();
    expect(notifCall![0]).toMatch(/'poke_accepted'/);
    expect(notifCall![1]).toContain('/messages/conv-9'); // straight into the conversation, not the inbox
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
      link: '/messages/conv-9',
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

describe('acceptPoke — fans the new conversation out to BOTH inboxes', () => {
  it('broadcasts the intro (notify:false) so the sender inbox gains the conversation with no duplicate DM bell', async () => {
    const pokeService = await import('../../../services/poke/poke.service');
    armAccept('You fit what they want. We think you two should meet.');
    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockBroadcastDm).toHaveBeenCalledTimes(1);
    const call = mockBroadcastDm.mock.calls[0] as unknown[];
    // (io, fromUserId, toUserId, conversationId, message, options)
    expect(call[1]).toBe(SENDER);      // intro is authored by the sender
    expect(call[2]).toBe(RECIPIENT);   // delivered to the accepter
    expect(call[3]).toBe('conv-9');
    expect(call[5]).toMatchObject({ notify: false });
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

/**
 * A pending request from SENDER to RECIPIENT, for the decline path: the claim
 * answers the way the database does (only a pending request sent to this
 * member changes), and the request can be read back by id.
 */
function armDecline(preferredFormat: string | null = null) {
  const request = {
    id: 'poke-1', sender_id: SENDER, recipient_id: RECIPIENT, status: 'pending', message: 'hi',
    responded_at: null as Date | null, created_at: new Date('2026-07-20T00:00:00Z'), preferred_format: preferredFormat,
  };
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/UPDATE user_pokes[\s\S]*WHERE id = \$1/.test(sql)) {
      if (request.status !== 'pending' || params[1] !== request.recipient_id) return Promise.resolve({ rows: [] });
      request.status = params[2] as string;
      request.responded_at = RESPONDED_AT;
      return Promise.resolve({ rows: [{ ...request }] });
    }
    if (/FROM user_pokes WHERE id/.test(sql)) return Promise.resolve({ rows: [{ ...request }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('declinePoke — still notifies nobody', () => {
  it('the sender is told nothing: no bell, no socket push, no email, and no tag addressed to them', async () => {
    armDecline();

    const result = await pokeService.declinePoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(result.status).toBe('declined');
    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
    // The recipient's own bell row may be marked read, and their own screens told;
    // nothing anywhere names the sender.
    for (const [, users, tags] of mockEmitEntities.mock.calls as Array<[unknown, string[], string[]]>) {
      expect(users).not.toContain(SENDER);
      for (const tag of tags) expect(tag).not.toContain(SENDER);
    }
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

describe('sendPoke — pokes-prefs bell gating (Settings "Pokes" bell toggle)', () => {
  it('poke_bell = false suppresses the notifications INSERT and the live socket push, but the email still fires (channels are independent)', async () => {
    armSend('hi');
    mockShouldSendBell.mockResolvedValue(false);

    const result = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockShouldSendBell).toHaveBeenCalledWith(RECIPIENT, 'poke');
    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    // 29 Sep 2026: the bell toggle silences the notification, not the data.
    // Screens still refresh; only the bell's own tag is withheld.
    const tags = mockEmitEntities.mock.calls.flatMap(c => c[2] as string[]);
    expect(tags).not.toContain(`user:${RECIPIENT}:notifications`);
    expect(result.status).toBe('pending');
    expect(mockSendPokeReceivedEmail).toHaveBeenCalled();
  });

  it('poke_bell absent/true (default) still inserts the notification and pushes the socket event (unchanged behaviour)', async () => {
    armSend('hi');

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');

    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(true);
    expect(mockTo).toHaveBeenCalledWith(`user:${RECIPIENT}`);
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ type: 'poke' }));
  });
});

describe('sendPoke — pokes-prefs email gating (Settings "Pokes" email toggle)', () => {
  it('poke_email = false suppresses the recipient email even though notify_email + email_config are both on', async () => {
    armSend('hi');
    mockShouldSendEmail.mockResolvedValue(false);

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockShouldSendEmail).toHaveBeenCalledWith(RECIPIENT, 'poke');
    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });

  it('global notify_email = false still suppresses the email even when poke_email = true (global switch > category switch)', async () => {
    armSend('hi', { recipientNotifyEmail: false });
    mockShouldSendEmail.mockResolvedValue(true);

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
  });

  it('poke_email absent/true (default) sends the email (unchanged behaviour)', async () => {
    armSend('hi');

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    await flushPromises();

    expect(mockSendPokeReceivedEmail).toHaveBeenCalled();
  });
});

describe('acceptPoke — pokes-prefs email gating (Settings "Pokes" email toggle)', () => {
  it('poke_email = false suppresses the sender email even though notify_email + email_config are both on', async () => {
    armAccept('Hello there');
    mockShouldSendEmail.mockResolvedValue(false);

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockShouldSendEmail).toHaveBeenCalledWith(SENDER, 'poke');
    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });

  it('global notify_email = false still suppresses the email even when poke_email = true (global switch > category switch)', async () => {
    armAccept('Hello there', { senderNotifyEmail: false });
    mockShouldSendEmail.mockResolvedValue(true);

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).not.toHaveBeenCalled();
  });

  it('poke_email absent/true (default) sends the email (unchanged behaviour)', async () => {
    armAccept('Hello there');

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(mockSendPokeAcceptedEmail).toHaveBeenCalled();
  });
});

describe('acceptPoke — the poke_accepted bell is NOT gated by prefs (DoD-critical, deliberate)', () => {
  it('still inserts the poke_accepted notification and pushes the socket event even when poke_bell AND poke_email are both false for the sender', async () => {
    armAccept('Hello there');
    mockShouldSendBell.mockResolvedValue(false);
    mockShouldSendEmail.mockResolvedValue(false);

    await pokeService.acceptPoke('poke-1', RECIPIENT);

    expect(mockQuery.mock.calls.some(c => /INSERT INTO notifications/.test(c[0] as string))).toBe(true);
    expect(mockTo).toHaveBeenCalledWith(`user:${SENDER}`);
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ type: 'poke_accepted' }));
    // shouldSendBell is never even consulted for the accept path — the bell
    // is unconditional by design (see the Task F1 / pokes-prefs comment in
    // poke.service.ts above the notifications INSERT inside acceptPoke).
    expect(mockShouldSendBell).not.toHaveBeenCalled();
  });
});

describe('notification-prefs.service.ts — pokes-prefs default flip', () => {
  const fsMod: typeof import('fs') = require('fs');
  const pathMod: typeof import('path') = require('path');
  const src: string = fsMod.readFileSync(
    pathMod.join(__dirname, '../../../services/notification-prefs/notification-prefs.service.ts'), 'utf8',
  );

  it('DEFAULT_PREFS.poke_email is true, so an absent key resolves to "send" (migration 084 flips the seeded false)', () => {
    const i = src.indexOf('export const DEFAULT_PREFS');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('};', i));
    expect(block).toMatch(/poke_email:\s*true/);
  });
});

describe('email.service.ts — F2 poke email templates + kill-switch', () => {
  const fsMod: typeof import('fs') = require('fs');
  const pathMod: typeof import('path') = require('path');
  const src: string = fsMod.readFileSync(
    pathMod.join(__dirname, '../../../services/email/email.service.ts'), 'utf8',
  );

  it('sendPokeReceivedEmail subject is "{senderName} wants to meet you on REASON" (plain, matching the house style)', () => {
    const i = src.indexOf('export async function sendPokeReceivedEmail(');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport async function ', i + 1));
    expect(fn).toMatch(/subject = `\$\{data\.senderName\} wants to meet you on REASON`/);
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

// ─── Where a meeting request stands (6 Aug 2026) ─────────────────────────────
//
// The profile showed a dead "Message — meet first" button to someone who had
// already been asked, or who had asked YOU — a wall where the way through was
// right there. The page needs the state to say so.
describe('getPokeWith — the state of a request between two people', () => {
  beforeEach(() => mockQuery.mockReset());

  it('looks both ways, newest first', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await pokeService.getPokeWith('u-me', 'u-them');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/sender_id = \$1 AND recipient_id = \$2/);
    expect(String(sql)).toMatch(/sender_id = \$2 AND recipient_id = \$1/);
    expect(String(sql)).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['u-me', 'u-them']);
  });

  it('reports one I sent', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'p1', status: 'pending', sender_id: 'u-me' }] });
    expect(await pokeService.getPokeWith('u-me', 'u-them'))
      .toEqual({ id: 'p1', status: 'pending', sentByMe: true });
  });

  it('reports one I received, so the profile can point at Messages', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'p2', status: 'pending', sender_id: 'u-them' }] });
    expect(await pokeService.getPokeWith('u-me', 'u-them'))
      .toEqual({ id: 'p2', status: 'pending', sentByMe: false });
  });

  it('returns null when nothing was ever sent, so the page offers to ask', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await pokeService.getPokeWith('u-me', 'u-them')).toBeNull();
  });

  it('surfaces a decline rather than hiding it', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'p3', status: 'declined', sender_id: 'u-me' }] });
    const r = await pokeService.getPokeWith('u-me', 'u-them');
    expect(r?.status).toBe('declined');
  });
});

// 7 Sep 2026 (Ali): a meeting request must show WHO is asking — a profile card,
// not just a name — so the recipient can decide before accepting.
describe('listReceivedPokes — the accept surface shows who is asking', () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns the sender's role and company so the request renders as a profile card", async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: 'p1', sender_id: 'u-them', recipient_id: 'u-me', status: 'pending',
      message: 'hi', responded_at: null, created_at: new Date(),
      display_name: 'Dana Dev', avatar_url: 'http://x/a.png',
      job_title: 'Founder', company: 'Acme',
    }] });
    const [row] = await pokeService.listReceivedPokes('u-me');
    expect(row.senderDisplayName).toBe('Dana Dev');
    expect(row.senderJobTitle).toBe('Founder');
    expect(row.senderCompany).toBe('Acme');
    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/u\.job_title/);
    expect(String(sql)).toMatch(/u\.company/);
  });

  it('carries the format the sender asked for, and null when they chose none', async () => {
    const row = {
      id: 'p1', sender_id: 'u-them', recipient_id: 'u-me', status: 'pending',
      message: 'hi', responded_at: null, created_at: new Date(),
      display_name: 'Dana Dev', avatar_url: null, job_title: null, company: null,
    };
    mockQuery.mockResolvedValue({ rows: [
      { ...row, preferred_format: 'coffee' },
      { ...row, id: 'p2', preferred_format: null },
    ] });
    const rows = await pokeService.listReceivedPokes('u-me');
    expect(rows.map(r => r.preferredFormat)).toEqual(['coffee', null]);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/p\.preferred_format/);
  });
});

describe('sendPoke — both members\' screens refresh (29 Sep 2026)', () => {
  it('tells the sender and the recipient, whatever the recipient\'s bell setting', async () => {
    armSend('hi');
    mockShouldSendBell.mockResolvedValue(false);

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');

    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [SENDER], [`user:${SENDER}`, `user:${SENDER}:invites`]);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [RECIPIENT], [`user:${RECIPIENT}`, `user:${RECIPIENT}:invites`]);
    const tags = mockEmitEntities.mock.calls.flatMap(c => c[2] as string[]);
    expect(tags).not.toContain(`user:${RECIPIENT}:notifications`);
  });

  it('with the bell on, the recipient\'s bell counter is told as well', async () => {
    armSend('hi');

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');

    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [RECIPIENT], [`user:${RECIPIENT}:notifications`]);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [RECIPIENT], [`user:${RECIPIENT}`, `user:${RECIPIENT}:invites`]);
  });

  it('stores the preferred format and returns it', async () => {
    armSend('hi');
    const poke = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi', undefined, 'coffee');
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect(insert[1]).toEqual([expect.any(String), SENDER, RECIPIENT, 'hi', null, 'coffee']);
    // The value itself, not just the key: armSend answers like the database, so
    // this fails if the INSERT stops writing the column or RETURNING stops naming it.
    expect(poke.preferredFormat).toBe('coffee');
  });

  it('a request that asked for no format comes back with preferredFormat null', async () => {
    armSend('hi');
    const poke = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect((insert[1] as unknown[])[5]).toBeNull();
    expect(poke.preferredFormat).toBeNull();
  });
});

describe('acceptPoke and declinePoke — the request they return keeps its preferred format', () => {
  // The answer is a claim: the UPDATE that changes the request is also what reads it back (RETURNING).
  const claimOfThePoke = () => mockQuery.mock.calls.find(c => /UPDATE user_pokes[\s\S]*WHERE id = \$1/.test(String(c[0])))!;

  it('acceptPoke reads the column and returns it', async () => {
    armAccept('hi', { preferredFormat: 'message_first' });

    const { poke } = await pokeService.acceptPoke('poke-1', RECIPIENT);

    expect(poke.preferredFormat).toBe('message_first');
    expect(String(claimOfThePoke()[0])).toMatch(/RETURNING[\s\S]*preferred_format/);
  });

  it('declinePoke reads the column and returns it', async () => {
    armDecline('video_20');

    const result = await pokeService.declinePoke('poke-1', RECIPIENT);

    expect(result.preferredFormat).toBe('video_20');
    expect(String(claimOfThePoke()[0])).toMatch(/RETURNING[\s\S]*preferred_format/);
  });
});

// 3 Oct 2026 (review): the request cards render line breaks (whitespace-pre-line),
// so a message made mostly of newlines would build a card hundreds of lines tall.
describe('sendPoke — a run of line breaks cannot build a very tall request', () => {
  async function storedMessage(sent: string) {
    mockQuery.mockClear(); // a test calls this more than once; each call reads only its own INSERT
    armSend('x');
    await pokeService.sendPoke(SENDER, RECIPIENT, sent);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    return (insert[1] as unknown[])[3];
  }

  it('folds a long run of line breaks to one blank line, so note, blank line, reason survives', async () => {
    const sent = `I would love your view.${'\n'.repeat(300)}Why REASON suggested this: a fit.`;
    expect(await storedMessage(sent)).toBe('I would love your view.\n\nWhy REASON suggested this: a fit.');
  });

  it('counts Windows line endings and lines holding only spaces as line breaks too', async () => {
    expect(await storedMessage('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
    expect(await storedMessage('a\n  \n\t\n \xa0 \nb')).toBe('a\n\nb');
  });

  it('leaves one line break, and one blank line, exactly as written', async () => {
    expect(await storedMessage('a\nb')).toBe('a\nb');
    expect(await storedMessage('a\n\nb')).toBe('a\n\nb');
  });

  it('spends the whole cap on what is left after folding, and still caps there', async () => {
    expect(await storedMessage(`a${'\n'.repeat(600)}b`)).toBe('a\n\nb');
    expect(String(await storedMessage('x'.repeat(REQUEST_MESSAGE_MAX + 100)))).toHaveLength(REQUEST_MESSAGE_MAX);
  });

  it('stores a message of exactly the request cap whole, and cuts one character more', async () => {
    // The route accepts, and the reason budget is measured against, this same cap.
    const atTheCap = 'x'.repeat(REQUEST_MESSAGE_MAX);
    expect(await storedMessage(atTheCap)).toBe(atTheCap);
    expect(await storedMessage(`${atTheCap}x`)).toBe(atTheCap);
  });
});

// ─── Answering a request is a claim (25 Oct 2026) ────────────────────────────
//
// On production Claus accepted Stefan's request on the Messages card, and the bell
// entry for it went on offering Accept; pressing it showed an error. The request row
// is now the one state: the first answer wins, the same answer again is already done
// and says where it went, and the other answer is a 409 that names the answer the
// request already has. Accepting also answers the request the other person had sent
// the other way, and asking someone who has already asked you is a match.
//
// A small model of the tables stands in for the database. Each transaction gets its
// own client and keeps a journal, so a transaction that throws puts the model back the
// way it was, as Postgres would, and a refused accept can be seen to change nothing.

interface RequestRow {
  id: string; sender_id: string; recipient_id: string; status: 'pending' | 'accepted' | 'declined';
  message: string | null; responded_at: Date | null; created_at: Date; preferred_format: string | null;
}
interface BellRow { user_id: string; type: string; link: string; is_read: boolean }
interface World {
  requests: RequestRow[];
  conversations: Array<{ id: string; user_a_id: string; user_b_id: string }>;
  bells: BellRow[];
  /** users.status by id; anyone not listed is active. */
  status: Record<string, string>;
}

const THIRD = 'u-third';

function pendingRequest(id: string, from: string, to: string, status: RequestRow['status'] = 'pending'): RequestRow {
  return {
    id, sender_id: from, recipient_id: to, status, message: `${from} would like to meet`,
    responded_at: null, created_at: new Date('2026-10-25T11:43:07Z'), preferred_format: null,
  };
}

/** The bell row sendPoke writes for a request: the recipient's, linking to /messages?poke=<id>. */
const bellFor = (r: RequestRow): BellRow => ({ user_id: r.recipient_id, type: 'poke', link: `/messages?poke=${r.id}`, is_read: false });

const statements = (pattern: RegExp) => mockQuery.mock.calls.filter(c => pattern.test(String(c[0])));

function armWorld(world: World) {
  let journal: Array<() => void> | null = null;
  const remember = (undo: () => void) => { journal?.push(undo); };
  mockTransactionHook = async (cb) => {
    const mine: Array<() => void> = [];
    const client: MockClient = {
      // mockQuery answers synchronously, so the journal it should write to can be handed over around the call.
      query: (...args: unknown[]) => {
        journal = mine;
        try { return mockQuery(...args); } finally { journal = null; }
      },
    };
    try {
      return await cb(client);
    } catch (err) {
      for (const undo of mine.reverse()) undo();
      throw err;
    }
  };

  const answer = (r: RequestRow, status: RequestRow['status']) => {
    const before = { status: r.status, responded_at: r.responded_at };
    r.status = status;
    r.responded_at = RESPONDED_AT;
    remember(() => Object.assign(r, before));
    return { rows: [{ ...r }] };
  };

  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    const none = { rows: [] as unknown[] };
    // The claim: one request, by id, still pending, sent to this member.
    if (/UPDATE user_pokes[\s\S]*WHERE id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
      const r = world.requests.find(x => x.id === params[0] && x.recipient_id === params[1] && x.status === 'pending');
      return Promise.resolve(r ? answer(r, params[2] as RequestRow['status']) : none);
    }
    // Accepting whatever request is still pending from one member to another.
    if (/UPDATE user_pokes SET status = 'accepted'[\s\S]*WHERE sender_id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
      const r = world.requests.find(x => x.sender_id === params[0] && x.recipient_id === params[1] && x.status === 'pending');
      return Promise.resolve(r ? answer(r, 'accepted') : none);
    }
    if (/UPDATE user_pokes/.test(sql)) throw new Error(`a write to user_pokes the model does not expect: ${sql}`);
    if (/FROM user_pokes WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: world.requests.filter(x => x.id === params[0]).map(x => ({ ...x })) });
    }
    if (/INSERT INTO user_pokes/.test(sql)) {
      const r: RequestRow = {
        id: params[0] as string, sender_id: params[1] as string, recipient_id: params[2] as string, status: 'pending',
        message: params[3] as string | null, responded_at: null, created_at: NOTIF_CREATED_AT,
        preferred_format: (params[5] as string | null) ?? null,
      };
      world.requests.push(r);
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/SELECT status FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ status: world.status[params[0] as string] ?? 'active' }] });
    }
    if (/FROM encounter_history/.test(sql)) return Promise.resolve(none);
    if (/SELECT id FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: params[0] }] });
    if (/INSERT INTO dm_conversations/.test(sql)) {
      const [, a, b] = params as string[];
      let conv = world.conversations.find(c => c.user_a_id === a && c.user_b_id === b);
      if (!conv) {
        const added = { id: `conv-${world.conversations.length + 1}`, user_a_id: a, user_b_id: b };
        world.conversations.push(added);
        remember(() => { world.conversations.splice(world.conversations.indexOf(added), 1); });
        conv = added;
      }
      return Promise.resolve({ rows: [{ id: conv.id }] });
    }
    if (/SELECT id FROM dm_conversations/.test(sql)) {
      const [x, y] = params as string[];
      return Promise.resolve({
        rows: world.conversations
          .filter(c => (c.user_a_id === x && c.user_b_id === y) || (c.user_a_id === y && c.user_b_id === x))
          .map(c => ({ id: c.id })),
      });
    }
    if (/INSERT INTO direct_messages/.test(sql)) {
      return Promise.resolve({ rows: [{
        id: params[0], conversation_id: params[1], from_user_id: params[2], content: params[3],
        read_at: null, created_at: NOTIF_CREATED_AT,
      }] });
    }
    if (/UPDATE notifications SET is_read = TRUE/.test(sql)) {
      // The member's poke bell row with exactly this link.
      const [userId, link] = params as string[];
      for (const b of world.bells) {
        if (b.user_id === userId && b.type === 'poke' && b.link === link && !b.is_read) {
          b.is_read = true;
          remember(() => { b.is_read = false; });
        }
      }
      return Promise.resolve(none);
    }
    if (/INSERT INTO notifications/.test(sql)) {
      const type = /VALUES \(\$1, \$2, '(\w+)'/.exec(sql)?.[1] ?? 'unknown';
      const added: BellRow = { user_id: params[1] as string, type, link: params[4] as string, is_read: false };
      world.bells.push(added);
      remember(() => { world.bells.splice(world.bells.indexOf(added), 1); });
      return Promise.resolve({ rows: [{ id: `notif-${world.bells.length}`, created_at: NOTIF_CREATED_AT }] });
    }
    if (/SELECT email, display_name, notify_email FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ email: `${params[0]}@example.com`, display_name: String(params[0]), notify_email: true }] });
    }
    if (/SELECT display_name FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ display_name: `Name of ${params[0]}` }] });
    }
    return Promise.resolve(none);
  });
}

function newWorld(requests: RequestRow[], bells: BellRow[] = requests.map(bellFor)): World {
  return { requests, conversations: [], bells, status: {} };
}

describe('acceptPoke and declinePoke are claims: one answer per request', () => {
  it('acceptPoke twice returns 200 with the same conversationId and creates one conversation', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    armWorld(world);

    const first = await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();
    const second = await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(first).toMatchObject({ poke: { id: 'poke-1', status: 'accepted' }, conversationId: 'conv-1' });
    expect(second).toMatchObject({ poke: { id: 'poke-1', status: 'accepted' }, conversationId: 'conv-1' });
    // Everything an accept does happened once: the stale second press repeats none of it.
    expect(statements(/INSERT INTO dm_conversations/)).toHaveLength(1);
    expect(statements(/INSERT INTO direct_messages/)).toHaveLength(1);
    expect(world.bells.filter(b => b.type === 'poke_accepted')).toHaveLength(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockBroadcastDm).toHaveBeenCalledTimes(1);
    expect(mockSendPokeAcceptedEmail).toHaveBeenCalledTimes(1);
  });

  it('acceptPoke after decline throws ConflictError code MEETING_REQUEST_ALREADY_ANSWERED with details.status declined', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT, 'declined')]);
    armWorld(world);

    await expect(pokeService.acceptPoke('poke-1', RECIPIENT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already declined this request.',
      details: { status: 'declined' },
    });
    expect(world.requests[0].status).toBe('declined');
    expect(statements(/INSERT INTO/)).toHaveLength(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('declinePoke after accept throws 409 with details.status accepted', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    armWorld(world);
    await pokeService.acceptPoke('poke-1', RECIPIENT);

    await expect(pokeService.declinePoke('poke-1', RECIPIENT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already accepted this request.',
      details: { status: 'accepted' },
    });
    expect(world.requests[0].status).toBe('accepted');
  });

  it('declining twice is done once: the second answer resolves with the request, still declined', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    armWorld(world);

    const first = await pokeService.declinePoke('poke-1', RECIPIENT);
    const second = await pokeService.declinePoke('poke-1', RECIPIENT);

    expect(first).toMatchObject({ id: 'poke-1', status: 'declined' });
    expect(second).toMatchObject({ id: 'poke-1', status: 'declined' });
  });

  it('a concurrent decline whose conditional UPDATE matches no row never overwrites an accept', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    armWorld(world);

    // Pressed at the same moment: the accept's claim lands first, so when the decline's
    // UPDATE runs the request is no longer pending and nothing matches.
    const [accepted, declined] = await Promise.allSettled([
      pokeService.acceptPoke('poke-1', RECIPIENT),
      pokeService.declinePoke('poke-1', RECIPIENT),
    ]);

    expect(accepted).toMatchObject({ status: 'fulfilled', value: { conversationId: 'conv-1' } });
    expect(declined).toMatchObject({ status: 'rejected', reason: { statusCode: 409, details: { status: 'accepted' } } });
    expect(world.requests[0].status).toBe('accepted');
    expect(world.conversations).toHaveLength(1);
    // Every write to a request is conditional on it still being pending.
    const writes = statements(/UPDATE user_pokes/);
    expect(writes.length).toBeGreaterThan(0);
    for (const [sql] of writes) expect(String(sql)).toMatch(/status = 'pending'/);
  });

  it('accept closes the reverse pending request with no second intro or bell', async () => {
    const asked = pendingRequest('poke-1', SENDER, RECIPIENT);
    const askedBack = pendingRequest('poke-2', RECIPIENT, SENDER);
    const world = newWorld([asked, askedBack]);
    armWorld(world);

    const { conversationId } = await pokeService.acceptPoke('poke-1', RECIPIENT);
    await flushPromises();

    expect(world.requests.map(r => r.status)).toEqual(['accepted', 'accepted']);
    expect(statements(/INSERT INTO direct_messages/)).toHaveLength(1);
    expect(world.bells.filter(b => b.type === 'poke_accepted')).toEqual([expect.objectContaining({ user_id: SENDER })]);
    // Both bell entries now read as answered, so neither person is offered Accept again.
    expect(world.bells.filter(b => b.type === 'poke').map(b => b.is_read)).toEqual([true, true]);
    // The request the other way is answered too: accepting it later is a repeat, not a second connection.
    const again = await pokeService.acceptPoke('poke-2', SENDER);
    expect(again.conversationId).toBe(conversationId);
    expect(statements(/INSERT INTO dm_conversations/)).toHaveLength(1);
    expect(mockSendPokeAcceptedEmail).toHaveBeenCalledTimes(1);
  });

  it('sendPoke when the recipient already asked me returns { status: accepted, conversationId } (mutual = match)', async () => {
    // RECIPIENT asked SENDER first; now SENDER asks RECIPIENT.
    const theirs = pendingRequest('poke-theirs', RECIPIENT, SENDER);
    const world = newWorld([theirs]);
    armWorld(world);

    const result = await pokeService.sendPoke(SENDER, RECIPIENT, 'Would love to meet');
    await flushPromises();

    expect(result).toMatchObject({ id: 'poke-theirs', status: 'accepted', conversationId: 'conv-1' });
    // No second request: theirs is answered, and nobody is told a new one arrived.
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0].status).toBe('accepted');
    expect(statements(/INSERT INTO user_pokes/)).toHaveLength(0);
    expect(mockSendPokeReceivedEmail).not.toHaveBeenCalled();
    // They hear that their request was accepted, once; my bell entry for their request reads answered.
    expect(world.bells.filter(b => b.type === 'poke_accepted')).toEqual([expect.objectContaining({ user_id: RECIPIENT })]);
    expect(world.bells.filter(b => b.type === 'poke')).toEqual([expect.objectContaining({ user_id: SENDER, is_read: true })]);
    expect(mockSendPokeAcceptedEmail).toHaveBeenCalledTimes(1);
    expect(mockBroadcastDm).toHaveBeenCalledTimes(1);
    // Both people's screens and bells refresh.
    const tagsFor = (u: string) => (mockEmitEntities.mock.calls as Array<[unknown, string[], string[]]>)
      .filter(([, users]) => users.includes(u)).flatMap(([, , tags]) => tags);
    for (const u of [SENDER, RECIPIENT]) {
      expect(tagsFor(u)).toEqual(expect.arrayContaining([`user:${u}`, `user:${u}:invites`, `user:${u}:notifications`]));
    }
  });

  it('accept refuses when a block stands between the two, whoever blocked whom (403), and changes nothing', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    armWorld(world);
    // areBlocked looks both ways in one query, so either person's block answers true.
    mockAreBlocked.mockResolvedValue(true);

    await expect(pokeService.acceptPoke('poke-1', RECIPIENT)).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });

    expect(mockAreBlocked).toHaveBeenCalledWith(SENDER, RECIPIENT);
    expect(world.requests[0].status).toBe('pending');
    expect(world.conversations).toHaveLength(0);
    expect(world.bells.filter(b => b.type === 'poke_accepted')).toHaveLength(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('accept refuses when the sender is no longer active (404, no longer available), and changes nothing', async () => {
    const world = newWorld([pendingRequest('poke-1', SENDER, RECIPIENT)]);
    world.status[SENDER] = 'deactivated';
    armWorld(world);

    await expect(pokeService.acceptPoke('poke-1', RECIPIENT)).rejects.toMatchObject({
      statusCode: 404,
      message: 'That member is no longer available.',
    });

    expect(world.requests[0].status).toBe('pending');
    expect(world.conversations).toHaveLength(0);
    expect(world.bells.every(b => !b.is_read)).toBe(true);
  });

  it("resolving a request marks the recipient's poke notification read", async () => {
    const accepted = pendingRequest('poke-1', SENDER, RECIPIENT);
    const declined = pendingRequest('poke-2', THIRD, RECIPIENT);
    const untouched = pendingRequest('poke-3', THIRD, SENDER);
    const world = newWorld([accepted, declined, untouched]);
    armWorld(world);

    await pokeService.acceptPoke('poke-1', RECIPIENT);
    await pokeService.declinePoke('poke-2', RECIPIENT);

    expect(world.bells.filter(b => b.type === 'poke').map(b => [b.link, b.is_read])).toEqual([
      ['/messages?poke=poke-1', true],
      ['/messages?poke=poke-2', true],
      ['/messages?poke=poke-3', false],
    ]);
    // The row is found by the link format sendPoke writes, scoped to the poke rows of that member.
    const marks = statements(/UPDATE notifications SET is_read = TRUE/);
    expect(marks.map(([, params]) => params)).toEqual([
      [RECIPIENT, '/messages?poke=poke-1'],
      [RECIPIENT, '/messages?poke=poke-2'],
    ]);
    for (const [sql] of marks) {
      expect(String(sql)).toMatch(/user_id = \$1/);
      expect(String(sql)).toMatch(/type = 'poke'/);
      expect(String(sql)).toMatch(/link = \$2/);
    }
  });

  it('the link the read is matched on is the very link sendPoke writes on the bell row', async () => {
    armSend('hi');
    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');
    const written = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(String(c[0])))!;
    const pokeId = (mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))![1] as string[])[0];

    expect((written[1] as string[])[4]).toBe(`/messages?poke=${pokeId}`);
  });
});

describe('listReceivedPokes — only requests that can still be answered', () => {
  it('leaves out requests from a member a block stands between, either way, and from members who are no longer active', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await pokeService.listReceivedPokes('u-me');

    const [sql, params] = mockQuery.mock.calls[0];
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toMatch(/u\.status = 'active'/);
    expect(flat).toMatch(/NOT EXISTS \( ?SELECT 1 FROM user_blocks b/);
    expect(flat).toMatch(/b\.blocker_id = \$1 AND b\.blocked_id = p\.sender_id/);
    expect(flat).toMatch(/b\.blocker_id = p\.sender_id AND b\.blocked_id = \$1/);
    expect(params).toEqual(['u-me']);
  });
});
