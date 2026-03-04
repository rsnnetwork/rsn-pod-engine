// ─── Pod Service Tests ───────────────────────────────────────────────────────
import { PodType, OrchestrationMode, CommunicationMode, PodVisibility, PodStatus, PodMemberRole } from '@rsn/shared';

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
});
