// ─── The bells a join request writes reach the screens through the notifications tag (26 Oct 2026, H2b item 6) ──
//
// Three paths write a bell straight into the notifications table: every admin is rung when someone asks to join,
// and an approved member gets a "Welcome" from the dashboard's Approve and from the one-click email's Approve.
// None of them told the member's screens (the entity tag user:<id>:notifications), so the bell filled in on the next
// poll or reload. Now each path tells the people it rang, once the rows are in.
//
// The real services run; the database, the emails, the realtime emitter and what they pull in are stand-ins.

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockClientQuery(sql, params) }),
  __esModule: true,
}));
jest.mock('../../../config', () => {
  const cfg = { clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test', magicLinkExpiryMinutes: 15, isDev: false };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendJoinRequestConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestDeclineEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestReminderEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestAdminReviewEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => 'none',
  runProvider: jest.fn(),
  resultFromOutcome: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/onboarding/enrichment.service', () => ({
  applyMatchVerification: jest.fn(),
  normalizeLinkedinUrl: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../middleware/auth', () => ({ invalidateUserStatusCache: jest.fn(), __esModule: true }));
jest.mock('../../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
const io = { name: 'the socket server' };
const mockEmit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  getRealtimeIo: () => io,
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  __esModule: true,
}));

import { createJoinRequest, reviewJoinRequest } from '../../../services/join-request/join-request.service';
import { confirmActionToken } from '../../../services/join-request/admin-action-tokens.service';
import { E } from '../../../realtime/entities';

const ADMIN_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000001';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('when someone asks to join', () => {
  it('every admin rung is told through their notifications tag', async () => {
    mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
      if (/SELECT id FROM join_requests WHERE email/.test(text)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO join_requests/.test(text)) {
        return Promise.resolve({ rows: [{ id: 'jr-1', full_name: params[0], email: params[1], status: 'pending' }] });
      }
      if (/INSERT INTO notifications/.test(text)) return Promise.resolve({ rows: [{ user_id: ADMIN_1 }, { user_id: ADMIN_2 }], rowCount: 2 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await createJoinRequest({ fullName: 'Sam Applicant', email: 'sam@getjacksapp.com', linkedinUrl: 'https://www.linkedin.com/in/sam', reason: 'I run a studio' });
    await flush();

    expect(mockEmit).toHaveBeenCalledWith(io, [ADMIN_1, ADMIN_2], [E.userNotifications(ADMIN_1), E.userNotifications(ADMIN_2)]);
  });

  it('tells nobody when no admin was rung (every admin already has this bell)', async () => {
    mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
      if (/INSERT INTO join_requests/.test(text)) return Promise.resolve({ rows: [{ id: 'jr-1', full_name: params[0], email: params[1], status: 'pending' }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await createJoinRequest({ fullName: 'Sam Applicant', email: 'sam@getjacksapp.com', linkedinUrl: null, reason: 'x' });
    await flush();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('when a request is approved', () => {
  it('from the dashboard: the approved member is told through their notifications tag', async () => {
    mockClientQuery.mockImplementation((text: string) => (
      /UPDATE join_requests/.test(text)
        ? Promise.resolve({ rows: [{ id: 'jr-1', full_name: 'Sam Applicant', email: 'sam@getjacksapp.com', linkedin_url: null, reason: 'x', status: 'approved' }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));
    mockQuery.mockImplementation((text: string) => (
      /INSERT INTO notifications/.test(text)
        ? Promise.resolve({ rows: [{ user_id: MEMBER }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));

    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(mockEmit).toHaveBeenCalledWith(io, [MEMBER], [E.userNotifications(MEMBER)]);
  });

  it('from the one-click email: the approved member is told through their notifications tag', async () => {
    mockQuery.mockImplementation((text: string) => {
      if (/FROM magic_links/.test(text) && /purpose = \$2/.test(text)) {
        return Promise.resolve({ rows: [{
          token_hash: 'h', expires_at: new Date(Date.now() + 3_600_000), used_at: null,
          target_user_id: 'admin-2', target_id: 'jr-1', action: 'approve',
        }], rowCount: 1 });
      }
      if (/INSERT INTO notifications/.test(text)) return Promise.resolve({ rows: [{ user_id: MEMBER }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((text: string) => (
      /UPDATE join_requests/.test(text)
        ? Promise.resolve({ rows: [{ id: 'jr-1', full_name: 'Sam Applicant', email: 'sam@getjacksapp.com' }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));

    const result = await confirmActionToken('a'.repeat(64));
    await flush();

    expect(result.kind).toBe('success');
    expect(mockEmit).toHaveBeenCalledWith(io, [MEMBER], [E.userNotifications(MEMBER)]);
  });
});
