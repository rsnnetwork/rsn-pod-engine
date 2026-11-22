// ─── Registering for an event of a pod inside a members-only main pod (22 Nov 2026) ───────────────────────────────
//
// Registering for an event of a public pod (an event with no visibility of its own) makes the person a member of the
// pod (session.service.ts). While the pod's main pod's director has "its pods are for its members" on, that path asks
// the same gate as every other way in (pod-parent-gate.ts), in the registration's own transaction and before any place
// is given: an outsider is refused in the event's words and nothing is written, neither a place nor a pod row. The real
// registration runs against the in-memory world (fixtures/waitlist-world.ts); the gate is stood in for so the test can
// say who it keeps out.

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/waitlist-world');
  return { query: w.run, transaction: w.inTransaction, __esModule: true };
});
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true,
}));
jest.mock('../../../realtime/fanout', () => ({
  fanoutSessionEntities: jest.fn().mockResolvedValue(undefined),
  fanoutSessionListEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  resolveSessionListAudience: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));
jest.mock('../../../services/session/registration-email', () => ({ sendRegistrationEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/post-event-message/event-organisers', () => ({ resolveEventOrganiserIds: async () => [], __esModule: true }));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: async () => ({ allowed: false, effectiveRole: 'participant' }), __esModule: true,
}));
const keptOut = new Set<string>();
const mockGate = jest.fn(async (_db: unknown, _podId: string, userId: string, voice: string) => {
  if (keptOut.has(userId)) {
    const { AppError } = jest.requireActual('../../../middleware/errors');
    const { mainPodRefusal } = jest.requireActual('../../../services/pods/pod-parent-gate');
    throw new AppError(403, 'MAIN_POD_MEMBERS_ONLY', mainPodRefusal({ name: 'Founders', visibility: 'public' }, voice));
  }
});
jest.mock('../../../services/pods/pod-parent-gate', () => ({
  ...jest.requireActual('../../../services/pods/pod-parent-gate'),
  assertMayJoinInnerPod: (...a: [unknown, string, string, string]) => mockGate(...a),
  __esModule: true,
}));

import { UserRole } from '@rsn/shared';
import { addEvent, addUser, placeOf, resetWaitlistWorld, wid, world } from '../../fixtures/waitlist-world';
import { registerParticipant } from '../../../services/session/session.service';

let n = 900;
const fresh = () => addUser({ id: wid(++n) }).id;
let EVENT: string;

beforeEach(() => {
  resetWaitlistWorld();
  keptOut.clear();
  mockGate.mockClear();
  EVENT = wid(++n);
  // A public pod's event with no visibility of its own: registering adds the person to the pod.
  addEvent({ id: EVENT, host_user_id: fresh(), visibility: null, admission_mode: null, pod_visibility: 'public', config: { maxParticipants: 10 } });
});

describe('an event of a public pod inside a members-only main pod', () => {
  it('an outsider is refused in the event\'s words, and neither a place nor a pod row is written', async () => {
    const ana = fresh();
    keptOut.add(ana);
    await expect(registerParticipant(EVENT, ana, UserRole.MEMBER)).rejects.toMatchObject({
      statusCode: 403,
      code: 'MAIN_POD_MEMBERS_ONLY',
      message: 'This event belongs to a pod inside Founders. Join Founders first. Its pods are for its members.',
    });
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), 'pod-1', ana, 'event');
    expect(placeOf(EVENT, ana)).toBeUndefined();
    expect(world.rows.podMembers.some((m) => m.user_id === ana)).toBe(false);
  });

  it('someone the main pod takes registers and joins the pod as before', async () => {
    const ben = fresh();
    await registerParticipant(EVENT, ben, UserRole.MEMBER);
    expect(placeOf(EVENT, ben)?.status).toBe('registered');
    expect(world.rows.podMembers.some((m) => m.user_id === ben && m.pod_id === 'pod-1')).toBe(true);
  });

  it('a member of the event\'s pod is not asked again (they join nothing)', async () => {
    const cara = fresh();
    world.rows.podMembers.push({ pod_id: 'pod-1', user_id: cara, role: 'member' });
    keptOut.add(cara);
    await registerParticipant(EVENT, cara, UserRole.MEMBER);
    expect(mockGate).not.toHaveBeenCalled();
    expect(placeOf(EVENT, cara)?.status).toBe('registered');
  });
});
