// ─── A block or an unblock tells both people's bells (26 Oct 2026) ───────────
//
// GET /notifications reads a meeting request as gone while a block stands between its two people, whichever
// of them made it, so a block or an unblock changes both people's bells. fanoutUserBlocks told only the
// blocks lists (user:<id>:blocks), and an open bell went on offering Accept until its next fetch. It now
// also sends each person their own user:<id>:notifications.

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn(async () => {});
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => (mockEmitEntities as jest.Mock)(...a),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { fanoutUserBlocks } from '../../realtime/fanout';

const BLOCKER = 'aaaaaaaa-0000-4000-8000-000000000001';
const BLOCKED = 'bbbbbbbb-0000-4000-8000-000000000002';

/** Every tag each person's room was sent. */
function tagsFor(userId: string): string[] {
  return (mockEmitEntities.mock.calls as unknown as Array<[unknown, string[], string[]]>)
    .filter(([, users]) => users.includes(userId))
    .flatMap(([, , tags]) => tags);
}

beforeEach(() => mockEmitEntities.mockClear());

describe('fanoutUserBlocks', () => {
  it('tells both people their blocks lists changed, as before', async () => {
    await fanoutUserBlocks(BLOCKER, BLOCKED);
    for (const user of [BLOCKER, BLOCKED]) {
      expect(tagsFor(user)).toEqual(expect.arrayContaining([`user:${BLOCKER}:blocks`, `user:${BLOCKED}:blocks`]));
    }
  });

  it('tells each person their own bell, so a request between them redraws as gone (or back) at once', async () => {
    await fanoutUserBlocks(BLOCKER, BLOCKED);
    expect(tagsFor(BLOCKER)).toContain(`user:${BLOCKER}:notifications`);
    expect(tagsFor(BLOCKED)).toContain(`user:${BLOCKED}:notifications`);
    // Each person is sent only their own bell's tag.
    expect(tagsFor(BLOCKER)).not.toContain(`user:${BLOCKED}:notifications`);
    expect(tagsFor(BLOCKED)).not.toContain(`user:${BLOCKER}:notifications`);
  });
});
