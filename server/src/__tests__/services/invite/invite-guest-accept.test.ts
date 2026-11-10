// ─── An event guest accepting an event invite (Part 2, Task 4, 10 Nov 2026; Task 3 review item) ──────────────
//
// A guest never joins a pod (pod.service addMember refuses them, Task 3). An event invite used to add its invitee to
// the event's pod first, so a guest's accept failed outright on that refusal. Now:
//   - an event with its own visibility (every event with an admission mode has one) never takes the pod step, as T11;
//   - an event that follows its pod skips the pod step for a guest, and registerParticipant decides: Task 3's
//     guestMayRegister, widened by admission (an invite to an event with a mode is an entitlement), lets them in or
//     refuses them with GUEST_MEMBERSHIP_REQUIRED, never with the pod refusal.
// Any other pod refusal still fails the accept. The services the invite calls are stand-ins.

import { ForbiddenError, AppError } from '../../../middleware/errors';

const EVENT = '5e1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const POD = '6f2b3c4d-5e6f-4a71-8b8c-0d1e2f3a4b5c';
const GUEST = '7a3c4d5e-6f70-4b82-9c9d-1e2f3a4b5c6d';
const GUEST_POD_REFUSAL = 'This person came to an event as a guest and is not a member yet, so they cannot join a pod.';

let eventVisibility: string | null = null;
const invite = {
  id: 'invite-1', code: 'CODE123', inviterId: 'host-1', inviteeEmail: null, circleId: null, status: 'pending',
  maxUses: 50, useCount: 0, expiresAt: new Date(Date.now() + 86_400_000), acceptedByUserId: null, acceptedAt: null,
  createdAt: new Date(), updatedAt: new Date(), type: 'session', podId: null, sessionId: EVENT,
};

const mockQuery = jest.fn(async (sql: string) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/FROM invites WHERE code = \$1 FOR UPDATE/.test(s)) return { rows: [invite], rowCount: 1 };
  if (s === 'SELECT status FROM sessions WHERE id = $1') return { rows: [{ status: 'scheduled' }], rowCount: 1 };
  if (s === 'SELECT pod_id AS "podId" FROM sessions WHERE id = $1') return { rows: [{ podId: POD }], rowCount: 1 };
  if (s === 'SELECT visibility FROM sessions WHERE id = $1') return { rows: [{ visibility: eventVisibility }], rowCount: 1 };
  if (s.startsWith('UPDATE invites')) return { rows: [{ ...invite, useCount: 1, status: 'accepted' }], rowCount: 1 };
  if (s === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') return { rows: [{ status: 'registered' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
jest.mock('../../../db', () => ({
  query: (sql: string) => mockQuery(sql),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string) => mockQuery(sql) }),
  __esModule: true,
}));
jest.mock('../../../config', () => ({ default: { clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001' }, __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({ sendInviteEmail: jest.fn(), __esModule: true }));
const mockJoinCircle = jest.fn();
jest.mock('../../../services/circle/circle.service', () => ({ joinCircle: (...a: unknown[]) => mockJoinCircle(...a), __esModule: true }));
const mockAddMember = jest.fn();
jest.mock('../../../services/pod/pod.service', () => ({
  addMember: (...args: unknown[]) => mockAddMember(...args),
  GUEST_POD_REFUSAL: 'This person came to an event as a guest and is not a member yet, so they cannot join a pod.',
  __esModule: true,
}));
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...args: unknown[]) => mockRegister(...args),
  __esModule: true,
}));

import { acceptInvite } from '../../../services/invite/invite.service';

beforeEach(() => {
  eventVisibility = null;
  mockAddMember.mockReset();
  mockRegister.mockReset();
  mockJoinCircle.mockReset();
  mockAddMember.mockRejectedValue(new ForbiddenError(GUEST_POD_REFUSAL));
  mockRegister.mockResolvedValue({ isNewRegistration: true });
});

describe('a guest accepting an event invite', () => {
  it('to an event with its own visibility (every event with an admission mode): no pod step, registered via the invite', async () => {
    eventVisibility = 'private';
    const result = await acceptInvite('CODE123', GUEST);
    expect(mockAddMember).not.toHaveBeenCalled();
    expect(mockRegister).toHaveBeenCalledWith(EVENT, GUEST, undefined, expect.objectContaining({ viaInvite: true }));
    expect(result.registeredFor.sessionId).toBe(EVENT);
    expect(mockJoinCircle).not.toHaveBeenCalled();
  });

  it('to an event that follows its pod: the pod refuses the guest, the accept goes on and registration decides', async () => {
    const result = await acceptInvite('CODE123', GUEST);
    expect(mockAddMember).toHaveBeenCalledWith(POD, GUEST);
    expect(mockRegister).toHaveBeenCalledWith(EVENT, GUEST, undefined, expect.objectContaining({ viaInvite: true }));
    // The guest is not in the pod, so the answer does not name it.
    expect(result.registeredFor).toEqual({ sessionId: EVENT });
  });

  it('when registration refuses the guest, they hear the guest rule, never the pod refusal', async () => {
    mockRegister.mockRejectedValue(new AppError(403, 'GUEST_MEMBERSHIP_REQUIRED', 'This event is for members. As a guest you can take part in the event you were invited to.'));
    await expect(acceptInvite('CODE123', GUEST)).rejects.toMatchObject({ statusCode: 403, code: 'GUEST_MEMBERSHIP_REQUIRED' });
  });

  it('any other refusal from the pod step still fails the accept', async () => {
    mockAddMember.mockRejectedValue(new ForbiddenError('Something else'));
    await expect(acceptInvite('CODE123', GUEST)).rejects.toMatchObject({ statusCode: 403, message: 'Something else' });
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
