// ─── Pod Join-Request Notification Tests ─────────────────────────────────────
// Stefan (2 Jul) — pod directors/hosts got no notification when someone
// requested to join their pod. requestToJoin must insert a 'join_request'
// bell notification for every active director/host and push it live via
// notification:new + the userNotifications entity tag.

const mockQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => mockTransaction(cb),
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockEmit = jest.fn();
const mockTo = jest.fn((_room: string) => ({ emit: mockEmit }));

jest.mock('../../index', () => ({
  io: { to: (room: string) => mockTo(room) },
  __esModule: true,
}));

const mockEmitEntities = jest.fn().mockResolvedValue(undefined);

jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as podService from '../../services/pod/pod.service';

const POD_ID = 'pod-1';
const REQUESTER_ID = 'requester-1';

const approvalPod = {
  id: POD_ID,
  name: 'Founding RSN Circle',
  status: 'active',
  visibility: 'public_with_approval',
  maxMembers: null,
};

const publicPod = { ...approvalPod, visibility: 'public' };

const pendingMemberRow = {
  id: 'member-1',
  podId: POD_ID,
  userId: REQUESTER_ID,
  role: 'member',
  status: 'pending_approval',
};

/** Wire the transaction mock so addMember's client queries succeed. */
function mockAddMemberTransaction(pod: object, memberRow: object) {
  mockTransaction.mockImplementation(async (cb: Function) => {
    const client = {
      query: jest.fn()
        // 1. SELECT pod FOR UPDATE
        .mockResolvedValueOnce({ rows: [pod], rowCount: 1 })
        // 2. existing-membership check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // 3. INSERT pod_members RETURNING
        .mockResolvedValueOnce({ rows: [memberRow], rowCount: 1 }),
    };
    return cb(client);
  });
}

describe('requestToJoin — approver notifications', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockEmit.mockClear();
    mockTo.mockClear();
    mockEmitEntities.mockClear();
  });

  it('notifies every active director/host with a join_request bell notification', async () => {
    // 1. getPodById
    mockQuery.mockResolvedValueOnce({ rows: [approvalPod], rowCount: 1 });
    mockAddMemberTransaction(approvalPod, pendingMemberRow);
    // 2. requester name lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ display_name: 'Stefan Avivson', email: 'stefanavivson@gmail.com' }],
      rowCount: 1,
    });
    // 3. INSERT notifications for approvers RETURNING
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'notif-1', user_id: 'director-1', created_at: new Date('2026-07-02T00:00:00Z') },
        { id: 'notif-2', user_id: 'host-1', created_at: new Date('2026-07-02T00:00:00Z') },
      ],
      rowCount: 2,
    });

    const member = await podService.requestToJoin(POD_ID, REQUESTER_ID);
    expect(member).toEqual(pendingMemberRow);

    // Notification insert targets directors + hosts with type join_request
    const insertCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toMatch(/'join_request'/);
    expect(insertCall![0]).toMatch(/role IN \('director', 'host'\)/);
    expect(insertCall![1]).toEqual(expect.arrayContaining([
      POD_ID,
      'Stefan Avivson wants to join Founding RSN Circle',
      `/pods/${POD_ID}`,
      REQUESTER_ID,
    ]));

    // Live push: notification:new to each approver's user room
    expect(mockTo).toHaveBeenCalledWith('user:director-1');
    expect(mockTo).toHaveBeenCalledWith('user:host-1');
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({
      type: 'join_request',
      title: 'New Join Request',
      body: 'Stefan Avivson wants to join Founding RSN Circle',
      link: `/pods/${POD_ID}`,
      isRead: false,
    }));

    // Entity tags: userNotifications for each recipient
    expect(mockEmitEntities).toHaveBeenCalledWith(
      expect.anything(),
      ['director-1', 'host-1'],
      expect.arrayContaining(['user:director-1:notifications', 'user:host-1:notifications']),
    );
  });

  it('does NOT create notifications for a public pod direct join', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publicPod], rowCount: 1 });
    mockAddMemberTransaction(publicPod, { ...pendingMemberRow, status: 'active' });

    await podService.requestToJoin(POD_ID, REQUESTER_ID);

    const insertCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO notifications')
    );
    expect(insertCall).toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('still returns the pending member when the notification insert fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [approvalPod], rowCount: 1 });
    mockAddMemberTransaction(approvalPod, pendingMemberRow);
    // requester name lookup blows up → notification path is non-fatal
    mockQuery.mockRejectedValueOnce(new Error('db down'));

    const member = await podService.requestToJoin(POD_ID, REQUESTER_ID);
    expect(member).toEqual(pendingMemberRow);
  });

  it('skips the socket push when no approvers exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [approvalPod], rowCount: 1 });
    mockAddMemberTransaction(approvalPod, pendingMemberRow);
    mockQuery.mockResolvedValueOnce({ rows: [{ display_name: 'X', email: 'x@y.z' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await podService.requestToJoin(POD_ID, REQUESTER_ID);

    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });
});
