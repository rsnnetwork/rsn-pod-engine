// ─── Pod Service Tests ───────────────────────────────────────────────────────
import { PodType, OrchestrationMode, CommunicationMode, PodVisibility, PodStatus, PodMemberRole, PodMemberStatus } from '@rsn/shared';

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

import * as podService from '../../services/pod/pod.service';

const mockPod = {
  id: 'pod-123',
  name: 'Test Pod',
  description: 'A test pod',
  podType: PodType.SPEED_NETWORKING,
  orchestrationMode: OrchestrationMode.TIMED_ROUNDS,
  communicationMode: CommunicationMode.VIDEO,
  visibility: PodVisibility.PRIVATE,
  status: PodStatus.ACTIVE,
  maxMembers: 50,
  rules: null,
  createdBy: 'user-123',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Pod Service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (cb: Function) => cb({ query: mockQuery }));
  });

  describe('getPodById', () => {
    it('should return pod when found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });

      const pod = await podService.getPodById('pod-123');
      expect(pod).toEqual(mockPod);
    });

    it('should throw NotFoundError when pod not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(podService.getPodById('missing'))
        .rejects.toThrow('not found');
    });
  });

  describe('createPod', () => {
    it('should create pod and add creator as director', async () => {
      // INSERT pod
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // INSERT pod_members (director)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const pod = await podService.createPod('user-123', {
        name: 'Test Pod',
        podType: PodType.SPEED_NETWORKING,
      });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(pod).toEqual(mockPod);
      // Verify second call is inserting into pod_members
      expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO pod_members');
    });
  });

  describe('listPods', () => {
    it('should return pods for a user', async () => {
      // COUNT query first
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      // Data query second
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });

      const result = await podService.listPods({ userId: 'user-123' });
      expect(result.pods).toHaveLength(1);
      expect(result.pods[0]).toEqual(mockPod);
      expect(result.total).toBe(1);
    });

    it('should return empty array when user has no pods', async () => {
      // COUNT query first
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      // Data query second
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await podService.listPods({ userId: 'user-no-pods' });
      expect(result.pods).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('getMemberRole', () => {
    it('should return the member role', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ role: PodMemberRole.HOST }],
        rowCount: 1,
      });

      const role = await podService.getMemberRole('pod-123', 'user-123');
      expect(role).toBe(PodMemberRole.HOST);
    });

    it('should return null when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const role = await podService.getMemberRole('pod-123', 'user-123');
      expect(role).toBeNull();
    });
  });

  describe('updatePod', () => {
    it('should update pod when user has director role', async () => {
      const updatedPod = { ...mockPod, name: 'Updated Pod' };
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // getMemberRole (requirePodRole)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // UPDATE pods RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [updatedPod], rowCount: 1 });

      const result = await podService.updatePod('pod-123', 'user-123', { name: 'Updated Pod' });
      expect(result.name).toBe('Updated Pod');
    });

    it('should return unchanged pod when no fields provided', async () => {
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // getMemberRole (requirePodRole)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });

      const result = await podService.updatePod('pod-123', 'user-123', {});
      expect(result).toEqual(mockPod);
    });

    it('should throw ForbiddenError when user lacks role', async () => {
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // getMemberRole — regular member
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 });

      await expect(podService.updatePod('pod-123', 'user-123', { name: 'X' }))
        .rejects.toThrow('Requires pod role');
    });
  });

  describe('addMember', () => {
    it('should add a new member to the pod', async () => {
      const mockMember = { id: 'pm-1', podId: 'pod-123', userId: 'user-new', role: 'member', status: 'active', joinedAt: new Date(), leftAt: null };
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // COUNT active members (capacity check since maxMembers=50)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1 });
      // Check existing membership — none found
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // INSERT pod_members
      mockQuery.mockResolvedValueOnce({ rows: [mockMember], rowCount: 1 });

      const result = await podService.addMember('pod-123', 'user-new');
      expect(result).toEqual(mockMember);
    });

    it('should throw ConflictError when pod is full', async () => {
      // getPodById — pod with maxMembers = 2
      mockQuery.mockResolvedValueOnce({ rows: [{ ...mockPod, maxMembers: 2 }], rowCount: 1 });
      // COUNT active members = 2 (full)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });

      await expect(podService.addMember('pod-123', 'user-new'))
        .rejects.toThrow('maximum member count');
    });

    it('should throw ConflictError when already an active member', async () => {
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // COUNT active members (capacity check)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1 });
      // Check existing membership — active
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-1', status: 'active' }], rowCount: 1 });

      await expect(podService.addMember('pod-123', 'user-existing'))
        .rejects.toThrow('already an active member');
    });

    it('should reactivate a previously left member', async () => {
      const reactivated = { id: 'pm-1', podId: 'pod-123', userId: 'user-left', role: 'member', status: 'active', joinedAt: new Date(), leftAt: null };
      // getPodById
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });
      // COUNT active members (capacity check)
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '10' }], rowCount: 1 });
      // Check existing — left status
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pm-1', status: 'left' }], rowCount: 1 });
      // UPDATE pod_members RETURNING
      mockQuery.mockResolvedValueOnce({ rows: [reactivated], rowCount: 1 });

      const result = await podService.addMember('pod-123', 'user-left');
      expect(result.status).toBe('active');
    });
  });

  describe('removeMember', () => {
    it('should remove a member when requester has director role', async () => {
      // getMemberRole for removedBy (requirePodRole)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // UPDATE pod_members SET status = removed
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await expect(podService.removeMember('pod-123', 'user-target', 'user-director'))
        .resolves.toBeUndefined();
    });

    it('should throw NotFoundError when member not found', async () => {
      // getMemberRole for removedBy
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'director' }], rowCount: 1 });
      // UPDATE rowCount = 0 (no matching active member)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(podService.removeMember('pod-123', 'user-not-found', 'user-director'))
        .rejects.toThrow('not found');
    });

    it('should throw ForbiddenError when requester lacks role', async () => {
      // getMemberRole — regular member
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 });

      await expect(podService.removeMember('pod-123', 'user-target', 'user-member'))
        .rejects.toThrow('Requires pod role');
    });
  });

  describe('leavePod', () => {
    it('should allow a member to leave', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await expect(podService.leavePod('pod-123', 'user-123'))
        .resolves.toBeUndefined();
    });

    it('should throw NotFoundError when member not active', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(podService.leavePod('pod-123', 'user-ghost'))
        .rejects.toThrow('not found');
    });
  });

  describe('getPodMembers', () => {
    it('should return all members', async () => {
      const members = [
        { id: 'pm-1', podId: 'pod-123', userId: 'user-1', role: 'director', status: 'active' },
        { id: 'pm-2', podId: 'pod-123', userId: 'user-2', role: 'member', status: 'active' },
      ];
      mockQuery.mockResolvedValueOnce({ rows: members, rowCount: 2 });

      const result = await podService.getPodMembers('pod-123');
      expect(result).toHaveLength(2);
    });

    it('should filter by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await podService.getPodMembers('pod-123', PodMemberStatus.ACTIVE);
      expect(result).toHaveLength(0);
      expect(mockQuery.mock.calls[0][0]).toContain('status = $2');
    });
  });

  describe('listPods - with filters', () => {
    it('should filter by podType', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [mockPod], rowCount: 1 });

      const result = await podService.listPods({ podType: PodType.SPEED_NETWORKING });
      expect(result.pods).toHaveLength(1);
      expect(mockQuery.mock.calls[0][0]).toContain('pod_type =');
    });

    it('should filter by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await podService.listPods({ status: PodStatus.ARCHIVED });
      expect(result.total).toBe(0);
    });
  });
});
