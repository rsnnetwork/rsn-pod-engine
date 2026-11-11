// ─── Accepting an invite when the pod or the event says "already" or "full" (26 Oct 2026, H2b item 1) ──
//
// applyInviteRegistration has always meant to treat "you are already in" as success: a member who opens a pod
// invite for a pod they are in, or an event invite for an event they are registered for, lands where the invite
// leads. Its branches tested `err instanceof ConflictError`, which was false for every ConflictError until AppError
// stopped resetting its subclasses' prototype, so those branches never ran and the member was answered 409 (which
// production's accept page turns into "You're already in" and a navigation of its own). Now they run, and they take
// only what their comments say: "already a member" and "already registered". A full pod or a full event is still a
// refusal (a capacity error "bubbles up so the user gets a definitive error"), and a full event is never filled past
// its cap by the defensive upsert that follows a registration. The session branch's pod step swallows POD_FULL as it
// always has (it names it), because registerParticipant decides whether the pod matters for the event.
//
// The services the invite calls are stand-ins that throw real ConflictErrors, as the real ones do.

import { ConflictError } from '../../../middleware/errors';

const EVENT = '5e1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const POD = '6f2b3c4d-5e6f-4a71-8b8c-0d1e2f3a4b5c';
const MEMBER = '7a3c4d5e-6f70-4b82-9c9d-1e2f3a4b5c6d';

let invite: Record<string, unknown>;
/** T11: the event's own visibility (NULL = the event follows its pod, as every event made before). */
let eventVisibility: string | null = null;
const baseInvite = {
  id: 'invite-1', code: 'CODE123', inviterId: 'host-1', inviteeEmail: null, circleId: null, status: 'pending',
  maxUses: 50, useCount: 0, expiresAt: new Date(Date.now() + 86_400_000), acceptedByUserId: null, acceptedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
};
const podInvite = () => ({ ...baseInvite, type: 'pod', podId: POD, sessionId: null });
const sessionInvite = () => ({ ...baseInvite, type: 'session', podId: null, sessionId: EVENT });

/** Every statement the accept ran, whitespace folded. */
const statements: string[] = [];
const mockQuery = jest.fn(async (sql: string) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  statements.push(s);
  if (/FROM invites WHERE code = \$1 FOR UPDATE/.test(s)) return { rows: [invite], rowCount: 1 };
  if (s === 'SELECT status FROM sessions WHERE id = $1') return { rows: [{ status: 'scheduled' }], rowCount: 1 };
  if (s === 'SELECT pod_id AS "podId" FROM sessions WHERE id = $1') return { rows: [{ podId: POD }], rowCount: 1 };
  if (s === 'SELECT visibility FROM sessions WHERE id = $1') return { rows: [{ visibility: eventVisibility }], rowCount: 1 };
  if (s.startsWith('UPDATE invites')) return { rows: [{ ...invite, useCount: 1, status: 'accepted' }], rowCount: 1 };
  if (s === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    return { rows: [{ status: 'registered' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../../../db', () => ({
  query: (sql: string) => mockQuery(sql),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string) => mockQuery(sql) }),
  __esModule: true,
}));
jest.mock('../../../config', () => ({
  default: { clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001' },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({ sendInviteEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/circle/circle.service', () => ({ joinCircle: jest.fn(), __esModule: true }));
const mockAddMember = jest.fn();
jest.mock('../../../services/pod/pod.service', () => ({
  addMember: (...args: unknown[]) => mockAddMember(...args),
  __esModule: true,
}));
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...args: unknown[]) => mockRegister(...args),
  __esModule: true,
}));
// Part 3 Task 3: the accept places people through registerOrWaitlist: the same mocked registration, unless a test says
// the event was full (mockQueued), when the person is put on the waiting list instead.
const mockQueued = jest.fn();
jest.mock('../../../services/session/event-waitlist.service', () => {
  const through = jest.requireActual('../../fixtures/waitlist-passthrough').passThroughWaitlist((...a: unknown[]) => mockRegister(...a));
  return {
    ...through,
    registerOrWaitlist: async (...a: unknown[]) => (mockQueued() ?? through.registerOrWaitlist(...(a as Parameters<typeof through.registerOrWaitlist>))),
  };
});

import { acceptInvite } from '../../../services/invite/invite.service';

const podMemberExists = () => new ConflictError('POD_MEMBER_EXISTS', 'User is already an active member of this pod');
const podFull = () => new ConflictError('POD_FULL', 'This pod has reached its maximum member count');
const alreadyRegistered = () => new ConflictError('SESSION_ALREADY_REGISTERED', 'You are already registered for this event');
const upserts = () => statements.filter((s) => s.startsWith('INSERT INTO session_participants'));

beforeEach(() => {
  statements.length = 0;
  mockAddMember.mockReset();
  mockRegister.mockReset();
  mockAddMember.mockResolvedValue({});
  mockRegister.mockResolvedValue({ isNewRegistration: true });
});

describe('a pod invite', () => {
  it('for a pod the member is already in lands them in the pod, as "already a member" always meant', async () => {
    invite = podInvite();
    mockAddMember.mockRejectedValueOnce(podMemberExists());
    await expect(acceptInvite('CODE123', MEMBER)).resolves.toMatchObject({
      redirectTo: `/pods/${POD}`, registeredFor: { podId: POD },
    });
  });

  it('for a full pod is still refused with the pod\'s own words', async () => {
    invite = podInvite();
    mockAddMember.mockRejectedValueOnce(podFull());
    await expect(acceptInvite('CODE123', MEMBER)).rejects.toMatchObject({
      statusCode: 409, code: 'POD_FULL', message: 'This pod has reached its maximum member count',
    });
    expect(statements.some((s) => s.startsWith('UPDATE invites'))).toBe(false);
  });
});

describe('an event invite', () => {
  it('for an event the member is already registered for lands them on the event', async () => {
    invite = sessionInvite();
    mockRegister.mockRejectedValueOnce(alreadyRegistered());
    await expect(acceptInvite('CODE123', MEMBER)).resolves.toMatchObject({
      redirectTo: `/sessions/${EVENT}`, registeredFor: { sessionId: EVENT, podId: POD }, participantStatus: 'registered',
    });
  });

  // Part 3 Task 3: a full event used to refuse the accept (409 SESSION_FULL, a dead end). It now puts the person on its
  // waiting list: the accept succeeds, lands them on the event page with their place in the line, and nobody is written
  // in past its cap (no defensive insert, no participant status).
  it('for a full event puts them on its waiting list, and nobody is written in past its cap', async () => {
    invite = sessionInvite();
    mockQueued.mockReturnValueOnce({ kind: 'waitlisted', position: 3, isNew: true });
    const result = await acceptInvite('CODE123', MEMBER);
    expect(result).toMatchObject({ redirectTo: `/sessions/${EVENT}`, registeredFor: { sessionId: EVENT }, waitlistPosition: 3 });
    expect(result.participantStatus).toBeUndefined();
    expect(upserts()).toEqual([]);
  });

  it('carries on when the pod step says the member is already in it, or that the pod is full (it names both)', async () => {
    for (const refusal of [podMemberExists, podFull]) {
      invite = sessionInvite();
      mockAddMember.mockRejectedValueOnce(refusal());
      await expect(acceptInvite('CODE123', MEMBER)).resolves.toMatchObject({ redirectTo: `/sessions/${EVENT}` });
      // A shared link (no address) passes no invite time: a removed member stays removed (H1b).
      expect(mockRegister).toHaveBeenLastCalledWith(EVENT, MEMBER, undefined, { personalInviteCreatedAt: undefined, viaInvite: true });
    }
  });

  // T11 (1 Nov 2026), D4: an event with its own visibility takes its invitee without making them a pod member.
  it('for an event with its own visibility registers the invitee without adding them to the pod', async () => {
    invite = sessionInvite();
    eventVisibility = 'private';
    mockAddMember.mockClear();
    try {
      await expect(acceptInvite('CODE123', MEMBER)).resolves.toMatchObject({ redirectTo: `/sessions/${EVENT}` });
      expect(mockAddMember).not.toHaveBeenCalled();
      expect(mockRegister).toHaveBeenLastCalledWith(EVENT, MEMBER, undefined, { personalInviteCreatedAt: undefined, viaInvite: true });
    } finally {
      eventVisibility = null;
    }
  });

  it('for a NULL event still adds the invitee to the pod first, as before', async () => {
    invite = sessionInvite();
    mockAddMember.mockClear();
    await acceptInvite('CODE123', MEMBER);
    // S2 fix round 1: with how they come in (an invite), so an organiser-removed member is not let back by any link.
    expect(mockAddMember).toHaveBeenCalledWith(POD, MEMBER, undefined, undefined, expect.objectContaining({ by: 'invite' }));
  });

  it('still fails on anything else the registration throws', async () => {
    invite = sessionInvite();
    mockRegister.mockRejectedValueOnce(new Error('connection reset'));
    await expect(acceptInvite('CODE123', MEMBER)).rejects.toThrow('connection reset');
    expect(upserts()).toEqual([]);
  });
});
