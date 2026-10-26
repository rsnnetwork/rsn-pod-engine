// ─── A shared link never re-admits a removed member (H1, fix round 1) ─────────────────────────────────
//
// #4B (June-10): a kicked member comes back only through a fresh PERSONAL invite from the host
// (allowRemovedReadmit); a shared link must not lift the removal. registerParticipant enforces that. After it
// succeeds, acceptInvite runs a defensive upsert for a row that vanished meanwhile, and that upsert also wrote
// `status = 'registered'` over a row a kick had just made `removed` (a kick landing between the two queries).
// It now lifts a removed row only for a personal invite. (Every ConflictError from the registration is
// rethrown, not swallowed: AppError resets each instance's prototype, so `instanceof ConflictError` is false;
// the upsert runs only after a registration that succeeded.)

type Row = { status: string };
const participants = new Map<string, Row>();
const EVENT = '5e1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const POD = '6f2b3c4d-5e6f-4a71-8b8c-0d1e2f3a4b5c';
const MEMBER = '7a3c4d5e-6f70-4b82-9c9d-1e2f3a4b5c6d';
const key = (userId: string) => `${EVENT}:${userId}`;

let invite: Record<string, unknown>;
function sessionInvite(inviteeEmail: string | null) {
  return {
    id: 'invite-1', code: 'CODE123', type: 'session', inviterId: 'host-1', inviteeEmail, podId: null, sessionId: EVENT,
    circleId: null, status: 'pending', maxUses: 50, useCount: 0, expiresAt: new Date(Date.now() + 86_400_000),
    acceptedByUserId: null, acceptedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => answer(sql.replace(/\s+/g, ' ').trim(), params));
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) }),
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
jest.mock('../../../services/pod/pod.service', () => ({ addMember: jest.fn(async () => ({})), __esModule: true }));
const mockRegister = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  registerParticipant: (...args: unknown[]) => mockRegister(...args),
  __esModule: true,
}));

import { acceptInvite } from '../../../services/invite/invite.service';

function answer(sql: string, params: unknown[]) {
  if (/FROM invites WHERE code = \$1 FOR UPDATE/.test(sql)) return { rows: [invite], rowCount: 1 };
  if (sql === 'SELECT status FROM sessions WHERE id = $1') return { rows: [{ status: 'lobby_open' }], rowCount: 1 };
  if (sql === 'SELECT pod_id AS "podId" FROM sessions WHERE id = $1') return { rows: [{ podId: POD }], rowCount: 1 };
  // The defensive upsert after registration, with Postgres's ON CONFLICT semantics.
  if (sql.startsWith('INSERT INTO session_participants (session_id, user_id, status)')) {
    const row = participants.get(`${params[0]}:${params[1]}`);
    if (!row) { participants.set(`${params[0]}:${params[1]}`, { status: 'registered' }); return { rows: [], rowCount: 1 }; }
    const liftsRemoved = /DO UPDATE SET status = 'registered'/.test(sql) && /WHERE session_participants\.status = 'removed'/.test(sql);
    if (liftsRemoved && row.status === 'removed') { row.status = 'registered'; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('UPDATE invites')) return { rows: [{ ...invite, useCount: 1, status: 'accepted' }], rowCount: 1 };
  if (sql === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const row = participants.get(`${params[0]}:${params[1]}`);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

/** The registration succeeds, then the host's kick lands before acceptInvite's next query. */
function registeredThenKicked() {
  mockRegister.mockImplementation(async () => {
    participants.set(key(MEMBER), { status: 'removed' });
    return { isNewRegistration: false };
  });
}

beforeEach(() => {
  participants.clear();
  mockRegister.mockReset();
});

describe('accepting an event invite while a kick lands', () => {
  it('a shared link leaves the kicked member removed', async () => {
    invite = sessionInvite(null);
    registeredThenKicked();
    await acceptInvite('CODE123', MEMBER);
    expect(mockRegister).toHaveBeenCalledWith(EVENT, MEMBER, undefined, { allowRemovedReadmit: false });
    expect(participants.get(key(MEMBER))?.status).toBe('removed');
  });

  it('a fresh personal invite re-admits them, as the host intended (unchanged)', async () => {
    invite = sessionInvite('member@rsn-e2e.invalid');
    registeredThenKicked();
    await acceptInvite('CODE123', MEMBER);
    expect(mockRegister).toHaveBeenCalledWith(EVENT, MEMBER, undefined, { allowRemovedReadmit: true });
    expect(participants.get(key(MEMBER))?.status).toBe('registered');
  });

  it('a row that vanished after the registration is put back by either link (unchanged)', async () => {
    for (const email of [null, 'member@rsn-e2e.invalid']) {
      participants.clear();
      invite = sessionInvite(email);
      mockRegister.mockResolvedValue({ isNewRegistration: true });
      await acceptInvite('CODE123', MEMBER);
      expect(participants.get(key(MEMBER))?.status).toBe('registered');
    }
  });
});
