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

import * as pokeService from '../../../services/poke/poke.service';

const SENDER = 'u-send';
const RECIPIENT = 'u-recv';
const ACCEPTER_NAME = 'Jamie Accepter';
const RESPONDED_AT = new Date('2026-07-23T12:00:00Z');
const NOTIF_CREATED_AT = new Date('2026-07-23T12:00:01Z');

/**
 * Wires mockQuery to answer every statement acceptPoke's transaction issues,
 * in the order the service currently runs them (SELECT ... FOR UPDATE,
 * UPDATE user_pokes, INSERT encounter_history, INSERT dm_conversations,
 * INSERT direct_messages, UPDATE dm_conversations, SELECT accepter name,
 * INSERT notifications). Regex-routed (not positional) so re-ordering the
 * service's queries doesn't silently break these tests the way a strict
 * mockResolvedValueOnce queue would.
 */
function armAccept(
  message: string | null,
  opts: { notifInsertImpl?: () => Promise<unknown> } = {},
) {
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

beforeEach(() => {
  mockQuery.mockReset();
  mockEmit.mockClear();
  mockTo.mockClear();
  mockEmitEntities.mockClear();
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
