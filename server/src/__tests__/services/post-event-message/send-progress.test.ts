// ─── Telling the people who run an event that a send moved on ─────────────────
//
// The worker (after each batch and at the end) and the route (when a send starts) both use this. The
// tag is the event's own, session:<id>, and the screens that show "Sending… x of y" declare it, so they
// refetch instead of polling. Telling is best-effort: it must never fail a send.

import { jest } from '@jest/globals';

const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockResolveOrganisers = jest.fn<any>();
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: (...a: unknown[]) => mockResolveOrganisers(...a),
  __esModule: true,
}));

const mockEmitEntities = jest.fn<any>();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmitEntities(...a),
  __esModule: true,
}));

import { reportProgress, resolveProgressAudience } from '../../../services/post-event-message/send-progress';

const io = { id: 'io' } as any;

beforeEach(() => {
  mockWarn.mockReset();
  mockResolveOrganisers.mockReset();
  mockEmitEntities.mockReset();
  mockEmitEntities.mockResolvedValue(undefined);
});

describe('resolveProgressAudience', () => {
  it('is the sender and everyone who runs the event, each once', async () => {
    mockResolveOrganisers.mockResolvedValue(['host', 'director', 'sender']);
    const audience = await resolveProgressAudience('sess-1', 'sender');
    expect(mockResolveOrganisers).toHaveBeenCalledWith('sess-1');
    expect(audience).toHaveLength(3);
    expect(new Set(audience)).toEqual(new Set(['host', 'director', 'sender']));
  });

  it('includes an admin sender who has no tie to the event', async () => {
    mockResolveOrganisers.mockResolvedValue(['host']);
    expect(new Set(await resolveProgressAudience('sess-1', 'admin'))).toEqual(new Set(['host', 'admin']));
  });

  it('falls back to the sender alone, and says so, when the organisers cannot be looked up', async () => {
    mockResolveOrganisers.mockRejectedValue(new Error('db blip'));
    expect(await resolveProgressAudience('sess-1', 'sender')).toEqual(['sender']);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('reportProgress', () => {
  it('tells the audience that the event moved, with the event\'s tag and nothing else', async () => {
    await reportProgress(io, ['a', 'b'], 'sess-1');
    expect(mockEmitEntities).toHaveBeenCalledWith(io, ['a', 'b'], ['session:sess-1']);
  });

  it('does nothing without a socket server (a process that has not started one)', async () => {
    await reportProgress(null, ['a'], 'sess-1');
    expect(mockEmitEntities).toHaveBeenCalledWith(null, ['a'], ['session:sess-1']); // emitEntities itself ignores null
  });

  it('logs and carries on when the tell fails', async () => {
    mockEmitEntities.mockRejectedValue(new Error('socket down'));
    await expect(reportProgress(io, ['a'], 'sess-1')).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
