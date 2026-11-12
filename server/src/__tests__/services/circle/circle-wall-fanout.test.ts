// ─── The circle wall tells the circle's screens (Shirley pilot S4, 11 Nov 2026; fix round 1) ─────────────────────
//
// fanoutCircleWall: every circle wall is read by its members only (D2), so its tags go to the circle's members and
// nobody else. fanoutCircleWallShares (fix round 1): a post's removal or edit also tells the circles that hold live
// shares of it, whose cards carry its words, at most CIRCLE_WALL_SHARES_MAX of them. Neither ever throws.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockWarn = jest.fn();
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...args: unknown[]) => mockWarn(...args), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockIo = { name: 'the socket server' };
let currentIo: typeof mockIo | null = mockIo;
const mockEmitEntities = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => currentIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import { CIRCLE_WALL_SHARES_MAX, fanoutCircleWall, fanoutCircleWallShares } from '../../../realtime/fanout';
import { E } from '../../../realtime/entities';

const C1 = 'c1c1c1c1-1111-4111-8111-111111111111';
const C2 = 'c2c2c2c2-2222-4222-8222-222222222222';
const POST = '9d2e4b61-7c3a-4d58-b1f0-6e5a4c3b2d10';
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

beforeEach(() => {
  jest.clearAllMocks();
  currentIo = mockIo;
  mockEmitEntities.mockResolvedValue(undefined);
});

describe('fanoutCircleWall', () => {
  it('tells the circle\'s members, and nobody else, its wall tag and the tags named', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'm1' }, { user_id: 'm2' }] });
    await fanoutCircleWall(C1, [E.circleWallPost(POST)]);
    expect(flat(mockQuery.mock.calls[0][0])).toBe('SELECT user_id FROM circle_members WHERE circle_id = $1');
    expect(mockQuery.mock.calls[0][1]).toEqual([C1]);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['m1', 'm2'], [`circle:${C1}:wall`, `circle-wall-post:${POST}`]);
  });

  it('wall: false leaves the feed\'s tag out (a like on a comment shows in the thread only)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 'm1' }] });
    await fanoutCircleWall(C1, [E.circleWallPost(POST)], { wall: false });
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['m1'], [`circle-wall-post:${POST}`]);
  });

  it('does nothing without a socket server, and never throws', async () => {
    currentIo = null;
    await fanoutCircleWall(C1);
    expect(mockQuery).not.toHaveBeenCalled();
    currentIo = mockIo;
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(fanoutCircleWall(C1)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('fanoutCircleWallShares (fix round 1)', () => {
  it('tells each circle holding a live share of the post, at most CIRCLE_WALL_SHARES_MAX', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ circle_id: C2 }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'm9' }] });
    await fanoutCircleWallShares(POST);
    expect(flat(mockQuery.mock.calls[0][0])).toBe(
      'SELECT DISTINCT circle_id FROM circle_posts WHERE shared_from_post_id = $1 AND deleted_at IS NULL ORDER BY circle_id LIMIT $2',
    );
    expect(mockQuery.mock.calls[0][1]).toEqual([POST, CIRCLE_WALL_SHARES_MAX]);
    expect(mockEmitEntities).toHaveBeenCalledWith(mockIo, ['m9'], [`circle:${C2}:wall`]);
  });

  it('no shares, nobody told; never throws', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await fanoutCircleWallShares(POST);
    expect(mockEmitEntities).not.toHaveBeenCalled();
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(fanoutCircleWallShares(POST)).resolves.toBeUndefined();
  });
});
