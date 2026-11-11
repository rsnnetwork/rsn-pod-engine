// ─── The event guest identity (Part 2, Task 3, 10 Nov 2026) ─────────────────────────────────────────────────
//
// An attendee who joins an event from its link gets a users row with account_kind = 'event_guest' (D2). Created
// verified but not onboarded and not visible; made a member by the approval of their platform join request, in that
// approval's transaction, on both ways an admin approves; never written to or rung by anyone, an admin included.
// Member creation is byte-for-byte as before.

const log: string[] = [];
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => { log.push(`query:${sql}`); return mockQuery(sql, params); },
  transaction: async (cb: (client: unknown) => unknown) => {
    log.push('tx:begin');
    const out = await cb({ query: (sql: string, params?: unknown[]) => { log.push(`tx:${sql}`); return mockClientQuery(sql, params); } });
    log.push('tx:commit');
    return out;
  },
  __esModule: true,
}));
jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.test', apiBaseUrl: 'https://api.test',
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestDeclineEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestReminderEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => 'none', runProvider: jest.fn(), resultFromOutcome: jest.fn(), statusFromResult: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/enrichment.service', () => ({
  applyMatchVerification: jest.fn(), normalizeLinkedinUrl: jest.fn(), __esModule: true,
}));
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  saveEnrichedCandidate: jest.fn(), setEnrichmentState: jest.fn(), __esModule: true,
}));
jest.mock('../../../services/onboarding/avatar.service', () => ({
  hasAvatar: jest.fn().mockResolvedValue(true), tryGravatar: jest.fn(), captureAvatar: jest.fn(), __esModule: true,
}));
jest.mock('../../../services/onboarding/stage-events.repo', () => ({ record: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  fanoutProfileChange: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: jest.fn().mockResolvedValue(false), __esModule: true }));

import * as auth from '../../../middleware/auth';
import { createUser, getUserById } from '../../../services/identity/identity.service';
import { promoteEventGuest } from '../../../services/identity/account-access';
import { reviewJoinRequest } from '../../../services/join-request/join-request.service';
import { confirmActionToken } from '../../../services/join-request/admin-action-tokens.service';
import { canMessage, sendMessage } from '../../../services/dm/dm.service';
import { callEligibility, requireConnection } from '../../../services/dm/call-eligibility';
import { recordAudit } from '../../../middleware/audit';
import { fanoutUserEntity } from '../../../realtime/fanout';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const GUEST_ID = '9e570000-0000-4000-8000-0000000000a1';
const EVENT = '9e570000-0000-4000-8000-0000000000e1';

beforeEach(() => {
  log.length = 0;
  jest.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─── Creating one ────────────────────────────────────────────────────────────────────────────────────────

describe('createUser', () => {
  /** getUserByEmail (nobody), the users INSERT, the subscription, the entitlements, then getUserById. */
  const answerCreate = (accountKind: string) => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: GUEST_ID, accountKind, bannerUpdatedAt: null }], rowCount: 1 });
  };
  const userInsert = () => mockQuery.mock.calls.find(([sql]) => /INSERT INTO users/.test(String(sql)))!;

  it('a guest is verified, not onboarded and not visible, and remembers the event they came in through', async () => {
    answerCreate('event_guest');
    const user = await createUser({
      email: 'Guest@Example.com', firstName: 'Gia', lastName: 'Guest', displayName: 'Gia G',
      accountKind: 'event_guest', guestFirstSessionId: EVENT,
    });
    const [sql, params] = userInsert();
    expect(flat(sql)).toBe(
      'INSERT INTO users (id, email, display_name, first_name, last_name, linkedin_url, role, status, email_verified, '
      + 'account_kind, guest_first_session_id, onboarding_completed, profile_visible) '
      + "VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active', TRUE, 'event_guest', $7, FALSE, FALSE)");
    expect(params).toEqual([expect.any(String), 'guest@example.com', 'Gia G', 'Gia', 'Guest', null, EVENT]);
    expect(user.accountKind).toBe('event_guest');
    expect(mockQuery).toHaveBeenCalledTimes(5); // the subscription and entitlements rows as for anyone
  });

  it('a guest who has not given a name yet goes by "Guest", never by their email', async () => {
    answerCreate('event_guest');
    await createUser({ email: 'nameless@example.com', firstName: '', lastName: '', accountKind: 'event_guest' });
    const params = userInsert()[1] as unknown[];
    expect(params[2]).toBe('Guest');
    expect(params[6]).toBeNull();
  });

  it('a member is created exactly as before: the same statement and the same values', async () => {
    answerCreate('member');
    await createUser({ email: 'Member@Example.com', firstName: 'Mia', lastName: 'Member' });
    const [sql, params] = userInsert();
    expect(flat(sql)).toBe(
      'INSERT INTO users (id, email, display_name, first_name, last_name, linkedin_url, role, status, email_verified) '
      + "VALUES ($1, $2, $3, $4, $5, $6, 'member', 'active', FALSE)");
    expect(params).toEqual([expect.any(String), 'member@example.com', 'Mia Member', 'Mia', 'Member', null]);
  });

  it('getUserById carries the kind', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GUEST_ID, accountKind: 'event_guest', bannerUpdatedAt: null }], rowCount: 1 });
    await expect(getUserById(GUEST_ID)).resolves.toMatchObject({ accountKind: 'event_guest' });
    expect(flat(mockQuery.mock.calls[0][0])).toContain('account_kind AS "accountKind"');
  });
});

// ─── Becoming a member ────────────────────────────────────────────────────────────────────────────────────

const REQUEST = { id: 'jr-1', full_name: 'Gia Guest', email: 'Gia@Example.com', linkedin_url: null, reason: 'x', status: 'approved' };
const PROMOTE = /UPDATE users SET account_kind = 'member'/;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** The approval transaction: the join_requests UPDATE, then whether the email has an active guest account. */
function approvalFinds(guest: boolean, joinRow: Record<string, unknown> = REQUEST) {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [joinRow], rowCount: 1 });
    if (PROMOTE.test(sql)) return Promise.resolve(guest ? { rows: [{ id: GUEST_ID }], rowCount: 1 } : { rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('promoteEventGuest', () => {
  it('turns the active guest with that email (whatever its case) into a visible member, and nothing else', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: GUEST_ID }], rowCount: 1 });
    const client = { query: mockClientQuery } as unknown as Parameters<typeof promoteEventGuest>[0];
    await expect(promoteEventGuest(client, 'Gia@Example.com')).resolves.toBe(GUEST_ID);
    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(flat(sql)).toBe(
      "UPDATE users SET account_kind = 'member', profile_visible = TRUE, updated_at = NOW() "
      + "WHERE LOWER(email) = LOWER($1) AND account_kind = 'event_guest' AND status = 'active' RETURNING id");
    expect(flat(sql)).not.toMatch(/onboarding_completed/); // onboarding stays to be done
    expect(params).toEqual(['Gia@Example.com']);
  });

  it('answers null when the email has no active guest account', async () => {
    const client = { query: mockClientQuery } as unknown as Parameters<typeof promoteEventGuest>[0];
    await expect(promoteEventGuest(client, 'member@example.com')).resolves.toBeNull();
  });
});

describe('approving the guest\'s join request makes them a member', () => {
  let forget: jest.SpyInstance;
  beforeEach(() => { forget = jest.spyOn(auth, 'forgetAccountGate'); });
  afterEach(() => forget.mockRestore());

  it('on the dashboard: in the approval transaction, then their cached kind is dropped and their screens told', async () => {
    approvalFinds(true);
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    const promoteAt = log.findIndex((l) => PROMOTE.test(l));
    expect(promoteAt).toBeGreaterThan(log.indexOf('tx:begin'));
    expect(promoteAt).toBeLessThan(log.indexOf('tx:commit'));
    expect(mockClientQuery.mock.calls.find(([sql]) => PROMOTE.test(String(sql)))![1]).toEqual(['Gia@Example.com']);
    expect(forget).toHaveBeenCalledWith(GUEST_ID);
    expect(fanoutUserEntity).toHaveBeenCalledWith(GUEST_ID);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1', action: 'user.guest_promoted_by_approval', entityId: GUEST_ID,
      details: expect.objectContaining({ joinRequestId: 'jr-1', via: 'dashboard' }),
    }));
  });

  it('a decline leaves the guest a guest', async () => {
    approvalFinds(true, { ...REQUEST, status: 'declined' });
    await reviewJoinRequest('jr-1', 'declined', 'admin-1');
    expect(log.some((l) => PROMOTE.test(l))).toBe(false);
    expect(forget).not.toHaveBeenCalled();
  });

  it('an applicant with no guest account is approved as before: nothing dropped, nothing recorded about a guest', async () => {
    approvalFinds(false);
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();
    expect(forget).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'user.guest_promoted_by_approval' }));
  });

  it('by the one-click email approval too', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM magic_links/.test(sql) && /purpose = \$2/.test(sql)) {
        return Promise.resolve({ rows: [{
          token_hash: 'h', expires_at: new Date(Date.now() + 3_600_000), used_at: null,
          target_user_id: 'admin-2', target_id: 'jr-1', action: 'approve',
        }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    approvalFinds(true, { id: 'jr-1', full_name: 'Gia Guest', email: 'gia@example.com' });
    const result = await confirmActionToken('a'.repeat(64));
    await flush();

    expect(result.kind).toBe('success');
    const promoteAt = log.findIndex((l) => PROMOTE.test(l));
    expect(promoteAt).toBeGreaterThan(log.indexOf('tx:begin'));
    expect(promoteAt).toBeLessThan(log.indexOf('tx:commit'));
    expect(forget).toHaveBeenCalledWith(GUEST_ID);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-2', action: 'user.guest_promoted_by_approval', details: expect.objectContaining({ via: 'email_action' }),
    }));
  });
});

// ─── Nobody opens a conversation with a guest, or rings one ─────────────────────────────────────────────

describe('messages and calls are for members', () => {
  const ME = '9e570000-0000-4000-8000-0000000000b1';
  /** canMessage's one read of the writer and the other account. */
  const accounts = (row: Record<string, unknown>) => mockQuery.mockImplementation((sql: string) => (
    /SELECT role, \(SELECT r\.account_kind FROM users r WHERE r\.id = \$2\) AS recipient_kind/.test(flat(sql))
      ? Promise.resolve({ rows: [row], rowCount: 1 })
      : Promise.resolve({ rows: [{ msg_count: '3', mutual_meet_again: true }], rowCount: 1 }) // they even share a thread
  ));

  it.each([
    ['a member writing to a guest', { role: 'member', sender_kind: 'member', recipient_kind: 'event_guest', recipient_active: true }],
    ['an admin writing to a guest', { role: 'admin', sender_kind: 'member', recipient_kind: 'event_guest', recipient_active: true }],
    ['a guest writing to a member', { role: 'member', sender_kind: 'event_guest', recipient_kind: 'member', recipient_active: true }],
  ])('%s: refused, whatever else the two share', async (_who, row) => {
    accounts(row);
    await expect(canMessage(ME, GUEST_ID)).resolves.toEqual({ allowed: false, reason: 'event_guest' });
  });

  it('creating the conversation by sending to a guest: 403, and no conversation or message is written', async () => {
    accounts({ role: 'admin', sender_kind: 'member', recipient_kind: 'event_guest', recipient_active: true });
    await expect(sendMessage(ME, GUEST_ID, 'Hello')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Messages are for members. This person came to an event as a guest and is not a member yet.',
    });
    expect(log.some((l) => /INSERT INTO (dm_conversations|direct_messages)/.test(l))).toBe(false);
    expect(log).not.toContain('tx:begin');
  });

  it('two members are not affected', async () => {
    accounts({ role: 'admin', sender_kind: 'member', recipient_kind: 'member', recipient_active: true });
    await expect(canMessage(ME, GUEST_ID)).resolves.toEqual({ allowed: true });
  });

  it('a call to or from a guest is refused in words, and the conversation it would open is never made', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      my_active: true, they_active: true, a_guest: true, their_name: 'Gia', blocked: false, connected: true,
    }], rowCount: 1 });
    await expect(callEligibility(ME, GUEST_ID)).resolves.toEqual({ allowed: false, reason: 'event_guest', name: 'Gia' });
    await expect(requireConnection(ME, GUEST_ID)).rejects.toMatchObject({
      statusCode: 403, message: 'Calls are for members. This person came to an event as a guest and is not a member yet.',
    });
    expect(flat(mockQuery.mock.calls[0][0])).toContain(
      "((SELECT me.account_kind FROM users me WHERE me.id = $1) = 'event_guest' OR t.account_kind = 'event_guest') AS a_guest");
  });
});

// ─── Pods are for members (fix round 1) ──────────────────────────────────────────────────────────────────

import { addMember, GUEST_POD_REFUSAL } from '../../../services/pod/pod.service';

describe('no pod_members row is ever written for an event guest', () => {
  const POD = { id: 'pod-1', maxMembers: null };
  /** The pod read, then whether they were ever in it, then the write (which a guest's account makes match nothing). */
  const podWorld = (existing: Array<{ id: string; status: string }>) => mockClientQuery.mockImplementation((sql: string) => {
    if (/FROM pods WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [POD], rowCount: 1 });
    if (/SELECT id, status, removal_kind, left_at FROM pod_members/.test(sql)) return Promise.resolve({ rows: existing, rowCount: existing.length });
    return Promise.resolve({ rows: [], rowCount: 0 }); // the guarded write matches no row for a guest
  });

  it('a new membership: the INSERT carries the member check, and a guest is refused in words', async () => {
    podWorld([]);
    await expect(addMember('pod-1', GUEST_ID)).rejects.toMatchObject({ statusCode: 403, message: GUEST_POD_REFUSAL });
    const insert = mockClientQuery.mock.calls.find(([sql]) => /INSERT INTO pod_members/.test(String(sql)))!;
    expect(flat(insert[0])).toContain("SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM users acct WHERE acct.id = $2 AND acct.account_kind = 'member')");
  });

  it('a membership brought back: the UPDATE carries the member check too', async () => {
    podWorld([{ id: 'pm-1', status: 'left' }]);
    await expect(addMember('pod-1', GUEST_ID)).rejects.toMatchObject({ statusCode: 403, message: GUEST_POD_REFUSAL });
    const update = mockClientQuery.mock.calls.find(([sql]) => /UPDATE pod_members SET role/.test(String(sql)))!;
    expect(flat(update[0])).toContain("AND EXISTS (SELECT 1 FROM users acct WHERE acct.id = $4 AND acct.account_kind = 'member')");
  });

  it('a member is added as before', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/FROM pods WHERE id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({ rows: [POD], rowCount: 1 });
      if (/INSERT INTO pod_members/.test(sql)) return Promise.resolve({ rows: [{ id: 'pm-2', userId: 'm' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(addMember('pod-1', 'm')).resolves.toMatchObject({ id: 'pm-2' });
  });
});

// ─── Where a guest may take a place (guestMayRegister, which Task 4/6 extend) ───────────────────────────

import { guestMayRegister } from '../../../services/session/guest-registration';

describe('guestMayRegister', () => {
  const S = '0e000000-0000-4000-8000-000000000001';
  const T = '0e000000-0000-4000-8000-000000000002';
  it.each([
    ['the event they came in through', { sessionId: S, guestFirstSessionId: S, holdsPlace: false }, true],
    ['an event where they already hold a row', { sessionId: T, guestFirstSessionId: S, holdsPlace: true }, true],
    ['any other event', { sessionId: T, guestFirstSessionId: S, holdsPlace: false }, false],
    ['any event, once the one they came in through is deleted', { sessionId: T, guestFirstSessionId: null, holdsPlace: false }, false],
  ])('%s → %s', (_name, facts, allowed) => {
    expect(guestMayRegister(facts)).toBe(allowed);
  });
});
