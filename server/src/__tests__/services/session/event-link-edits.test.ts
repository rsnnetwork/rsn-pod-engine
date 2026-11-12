// ─── The event link follows the event's forms (Stefan, 11 Nov 2026) ───────────────────────────────────────────────────
//
// The name is chosen when the event is created or edited (organisers only, checked by Zod on the route), and an edit
// that can add or drop the tail (visibility, circle, invitation-only) brings the link up to date after the event's own
// write. event-link.service.ts itself has its own tests (event-link.test.ts); here it is a mock, and these tests pin
// who calls it, with what, and that the reply carries the name.

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (c: unknown) => Promise<unknown>) => mockTransaction(cb),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockEnsureEventLink = jest.fn();
const mockEnsureEventLinkIn = jest.fn();
jest.mock('../../../services/session/event-link.service', () => ({
  ...jest.requireActual('../../../services/session/event-link.service'),
  ensureEventLink: (...a: unknown[]) => mockEnsureEventLink(...a),
  ensureEventLinkIn: (...a: unknown[]) => mockEnsureEventLinkIn(...a),
  fanoutEventLink: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/session/call-link.service', () => ({
  ...jest.requireActual('../../../services/session/call-link.service'),
  ensureCallCode: jest.fn().mockResolvedValue('k7m2x9q4ra'),
}));

import { DEFAULT_SESSION_CONFIG, SessionStatus } from '@rsn/shared';
import * as sessionService from '../../../services/session/session.service';
import { createSessionSchema, eventLinkNameSchema, updateSessionSchema } from '../../../routes/sessions';

const SESSION = '00000000-0000-4000-8000-000000000100';
const POD = '00000000-0000-4000-8000-000000000200';
const row = {
  id: SESSION, podId: POD, title: 'Founders breakfast', description: null, scheduledAt: new Date('2026-12-01T10:00:00Z'),
  startedAt: null, endedAt: null, status: SessionStatus.SCHEDULED, currentRound: 0, config: DEFAULT_SESSION_CONFIG,
  hostUserId: 'host', lobbyRoomId: null, visibility: 'public', circleId: null, publication: 'published', timezone: 'UTC',
  linkName: 'rsn', hasImage: false, imageUpdatedAt: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  mockQuery.mockReset();
  mockTransaction.mockReset().mockImplementation((cb: (c: unknown) => Promise<unknown>) => cb({ query: (...a: unknown[]) => mockQuery(...a) }));
  mockEnsureEventLink.mockReset().mockResolvedValue({ name: 'founders', number: 3, tail: null });
  mockEnsureEventLinkIn.mockReset().mockResolvedValue({ parts: { name: 'founders', number: 3, tail: null }, changed: true });
});

describe('the route\'s link-name field', () => {
  it('is trimmed and lower-cased, held to the shared rule, refused in the organiser\'s words; empty means not chosen', () => {
    expect(eventLinkNameSchema.parse('  Founders-Breakfast ')).toBe('founders-breakfast');
    expect(eventLinkNameSchema.parse('')).toBeUndefined();
    expect(eventLinkNameSchema.parse('   ')).toBeUndefined();
    const refused = (raw: string) => {
      const r = eventLinkNameSchema.safeParse(raw);
      return r.success ? null : r.error.issues[0].message;
    };
    expect(refused('admin')).toBe('That name is kept for REASON itself. Choose another.');
    expect(refused('events')).toBe('That name is kept for REASON itself. Choose another.');
    expect(refused('my event')).toContain('Use 2 to 40');
    expect(refused('a')).toBe('The link name needs at least 2 characters.');
    expect(refused('x'.repeat(41))).toBe('The link name can have at most 40 characters.');
    expect(refused('x'.repeat(101))).toBe('The link name can have at most 40 characters.');
  });

  it('rides on the create and the edit bodies, and is optional on both (production\'s forms send none)', () => {
    const base = { podId: POD, title: 'T', scheduledAt: '2026-12-01T10:00:00.000Z' };
    expect(createSessionSchema.parse({ ...base, linkName: 'Founders' }).linkName).toBe('founders');
    expect(createSessionSchema.parse(base).linkName).toBeUndefined();
    expect(updateSessionSchema.parse({ linkName: 'rsn' }).linkName).toBe('rsn');
    expect(updateSessionSchema.safeParse({ linkName: 'api' }).success).toBe(false);
  });
});

describe('creating an event', () => {
  function primeCreate() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: POD, name: 'Pod', status: 'active', podType: 'speed_networking' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ timezone: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row, linkName: null }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });
  }

  it('gives the link the name chosen, and the reply carries it', async () => {
    primeCreate();
    const created = await sessionService.createSession('host', {
      podId: POD, title: 'Founders breakfast', scheduledAt: '2026-12-01T10:00:00.000Z', linkName: 'founders',
    });
    const inserted = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO sessions'))![1][0];
    expect(mockEnsureEventLink).toHaveBeenCalledWith(inserted, 'founders');
    expect(created.linkName).toBe('founders');
  });

  it('with no name chosen, leaves the default to the link service', async () => {
    primeCreate();
    await sessionService.createSession('host', { podId: POD, title: 'T', scheduledAt: '2026-12-01T10:00:00.000Z' });
    expect(mockEnsureEventLink).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('a link that cannot be given now never undoes the event (its first read gives it one)', async () => {
    primeCreate();
    mockEnsureEventLink.mockRejectedValueOnce(new Error('connection reset'));
    const created = await sessionService.createSession('host', { podId: POD, title: 'T', scheduledAt: '2026-12-01T10:00:00.000Z' });
    expect(created.id).toBe(SESSION);
    expect(created.linkName).toBeNull();
  });
});

describe('editing an event', () => {
  it('a new name alone (nothing else to write) renames the link and answers with the new name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const updated = await sessionService.updateSession(SESSION, 'host', { linkName: 'founders' });
    expect(mockEnsureEventLink).toHaveBeenCalledWith(SESSION, 'founders');
    expect(updated.linkName).toBe('founders');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('a visibility change brings the link up to date after the event\'s own write, in the same transaction (review M4)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row, visibility: 'private' }], rowCount: 1 });
    const client = { query: (...a: unknown[]) => mockQuery(...a) };
    mockTransaction.mockImplementation((cb: (c: unknown) => Promise<unknown>) => cb(client));
    mockEnsureEventLinkIn.mockImplementation(async (c: unknown) => {
      // The UPDATE of sessions has already run, on the same transaction's client, when the link is looked at.
      expect(c).toBe(client);
      expect(mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE sessions SET visibility'))).toBe(true);
      return { parts: { name: 'rsn', number: 4, tail: 'k7m2q9' }, changed: true };
    });
    const updated = await sessionService.updateSession(SESSION, 'host', { visibility: 'private' });
    expect(mockEnsureEventLinkIn).toHaveBeenCalledWith(client, SESSION, undefined);
    expect(updated.linkName).toBe('rsn');
  });

  it('a link that cannot be written fails the edit as a whole: the transaction rolls the row back with it', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row, visibility: 'private' }], rowCount: 1 });
    let rolledBack = false;
    mockTransaction.mockImplementation(async (cb: (c: unknown) => Promise<unknown>) => {
      try { return await cb({ query: (...a: unknown[]) => mockQuery(...a) }); } catch (err) { rolledBack = true; throw err; }
    });
    mockEnsureEventLinkIn.mockRejectedValueOnce(new Error('connection reset'));
    await expect(sessionService.updateSession(SESSION, 'host', { visibility: 'private' })).rejects.toThrow('connection reset');
    expect(rolledBack).toBe(true);
  });

  it('ruling (b): a non-admin may not name an event rsn, creating or editing; an admin may; a kept rsn is no problem', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, linkName: 'founders' }], rowCount: 1 });
    await expect(sessionService.updateSession(SESSION, 'host', { linkName: 'rsn' })).rejects.toMatchObject({
      statusCode: 400, message: 'This name is reserved.', details: { linkName: ['This name is reserved.'] },
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, linkName: 'rsn' }], rowCount: 1 });
    await sessionService.updateSession(SESSION, 'host', { linkName: 'rsn' });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, linkName: 'founders' }], rowCount: 1 });
    await sessionService.updateSession(SESSION, 'someone', { linkName: 'rsn' }, 'admin' as never);
    expect(mockEnsureEventLink).toHaveBeenCalledWith(SESSION, 'rsn');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: POD, name: 'Pod', status: 'active', podType: 'speed_networking' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
    await expect(sessionService.createSession('host', { podId: POD, title: 'T', scheduledAt: '2026-12-01T10:00:00.000Z', linkName: 'rsn' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'This name is reserved.' });
  });

  it('a title-only edit leaves the link alone', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row, title: 'New' }], rowCount: 1 });
    await sessionService.updateSession(SESSION, 'host', { title: 'New' });
    expect(mockEnsureEventLink).not.toHaveBeenCalled();
  });

  it('only the host (or an admin) renames, and never once the event has started', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    await expect(sessionService.updateSession(SESSION, 'someone', { linkName: 'mine' })).rejects.toThrow('Only the host of the event');
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, status: SessionStatus.ROUND_ACTIVE }], rowCount: 1 });
    await expect(sessionService.updateSession(SESSION, 'host', { linkName: 'mine' })).rejects.toThrow('already started');
    expect(mockEnsureEventLink).not.toHaveBeenCalled();
  });
});
