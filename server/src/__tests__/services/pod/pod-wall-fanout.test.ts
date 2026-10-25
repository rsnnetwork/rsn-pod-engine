// ─── The pod wall tells the pod's screens (26 Oct 2026) ──────────────────────
//
// Every change to a pod's wall tells the members who could be looking at it: the pod's ACTIVE members,
// and nobody else. fanoutPodWall is not fanoutPodEntities: that one also re-tags the pod, its members and
// its invites, and its audience includes invited, pending and left rows (anyone whose status is not
// removed or declined), none of whom may read the wall. The two tags are named once on each side
// (server/src/realtime/entities.ts and client/src/realtime/entities.ts) and ENTITIES.md is the vocabulary
// both read.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

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

import { fanoutPodWall } from '../../../realtime/fanout';
import { E } from '../../../realtime/entities';

const POD = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const POST = '9d2e4b61-7c3a-4d58-b1f0-6e5a4c3b2d10';

/** The members of the pod, by the status the SQL asks for. */
const members = [
  { user_id: 'active-1', status: 'active' },
  { user_id: 'active-2', status: 'active' },
  { user_id: 'invited-1', status: 'invited' },
  { user_id: 'pending-1', status: 'pending_approval' },
  { user_id: 'left-1', status: 'left' },
  { user_id: 'removed-1', status: 'removed' },
  { user_id: 'declined-1', status: 'declined' },
];

beforeEach(() => {
  jest.clearAllMocks();
  currentIo = mockIo;
  mockEmitEntities.mockResolvedValue(undefined);
  // A fake pod_members that answers the way Postgres would for the status the query names.
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    const wantsActive = /status = 'active'/.test(text);
    const notRemoved = /status NOT IN \('removed', 'declined'\)/.test(text);
    if (!/FROM pod_members WHERE pod_id = \$1/.test(text) || params[0] !== POD) return { rows: [] };
    const rows = members.filter(m => (wantsActive ? m.status === 'active' : notRemoved ? !['removed', 'declined'].includes(m.status) : true));
    return { rows: rows.map(m => ({ user_id: m.user_id })) };
  });
});

describe('the realtime vocabulary', () => {
  it('names a pod\'s wall and one post on it', () => {
    expect(E.podWall(POD)).toBe(`pod:${POD}:wall`);
    expect(E.podWallPost(POST)).toBe(`pod-wall-post:${POST}`);
  });

  it('ENTITIES.md lists both tags', () => {
    const md = nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../ENTITIES.md'), 'utf8');
    expect(md).toMatch(/\| `pod:<podId>:wall` \|/);
    expect(md).toMatch(/\| `pod-wall-post:<postId>` \|/);
  });
});

describe('fanoutPodWall', () => {
  it('tells the pod\'s ACTIVE members, and nobody invited, pending, left, removed or declined', async () => {
    await fanoutPodWall(POD);
    expect(mockEmitEntities).toHaveBeenCalledTimes(1);
    const [io, userIds] = mockEmitEntities.mock.calls[0];
    expect(io).toBe(mockIo);
    expect([...userIds].sort()).toEqual(['active-1', 'active-2']);
    // The audience is chosen in SQL by status, not filtered afterwards.
    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/FROM pod_members WHERE pod_id = \$1 AND status = 'active'/);
  });

  it('sends the wall\'s own tag and no other pod tag', async () => {
    await fanoutPodWall(POD);
    const entities = mockEmitEntities.mock.calls[0][2];
    expect(entities).toEqual([`pod:${POD}:wall`]);
    expect(entities).not.toContain(E.pod(POD));
    expect(entities).not.toContain(E.podMembers(POD));
    expect(entities).not.toContain(E.podInvites(POD));
  });

  it('adds the extra tags a caller names, after the wall\'s own', async () => {
    await fanoutPodWall(POD, [E.podWallPost(POST)]);
    expect(mockEmitEntities.mock.calls[0][2]).toEqual([`pod:${POD}:wall`, `pod-wall-post:${POST}`]);
  });

  it('can leave the wall\'s own tag out, for a change only one post\'s thread shows (a like on a comment)', async () => {
    await fanoutPodWall(POD, [E.podWallPost(POST)], { wall: false });
    expect(mockEmitEntities.mock.calls[0][2]).toEqual([`pod-wall-post:${POST}`]);
  });

  it('does nothing when there is no socket server, and asks the database for nothing', async () => {
    currentIo = null;
    await fanoutPodWall(POD);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('never throws: a database error is logged and the change that was saved is still saved', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(fanoutPodWall(POD)).resolves.toBeUndefined();
    expect(mockEmitEntities).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
