// ─── The bells for a join request say REASON (21 Oct 2026) ───────────────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". Three bell notifications
// are written straight into the notifications table by the join-request code: the one
// every admin gets when someone asks to join, and the "Welcome" an approved member gets,
// written by two paths (the dashboard's Approve and the one-click email's Approve).
//
// The real services run; only the database, the emails and what they pull in are stand-ins.

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

import { createJoinRequest, reviewJoinRequest } from '../../../services/join-request/join-request.service';
import { confirmActionToken } from '../../../services/join-request/admin-action-tokens.service';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const oneLine = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ');
const bellsWritten = () => mockQuery.mock.calls.filter((c) => /INSERT INTO notifications/.test(String(c[0])));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('the bell every admin gets when someone asks to join', () => {
  it('says "{name} wants to join REASON"', async () => {
    mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
      if (/SELECT id FROM join_requests WHERE email/.test(text)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO join_requests/.test(text)) {
        return Promise.resolve({ rows: [{ id: 'jr-1', full_name: params[0], email: params[1], linkedin_url: params[2], reason: params[3], status: 'pending' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await createJoinRequest({ fullName: 'Sam Applicant', email: 'sam@example.com', linkedinUrl: 'https://www.linkedin.com/in/sam', reason: 'I run a studio' });
    await flush();

    const bells = bellsWritten();
    expect(bells).toHaveLength(1);
    expect(oneLine(bells[0])).toContain("$1 || ' wants to join REASON'");
    expect(oneLine(bells[0])).not.toMatch(/\bRSN\b/);
    expect(bells[0][1]).toEqual(['Sam Applicant']);
  });
});

describe('the "Welcome" bell an approved member gets', () => {
  it('says "Welcome to REASON!" when an admin approves from the dashboard', async () => {
    mockClientQuery.mockImplementation((text: string) => (
      /UPDATE join_requests/.test(text)
        ? Promise.resolve({ rows: [{ id: 'jr-1', full_name: 'Sam Applicant', email: 'sam@example.com', linkedin_url: null, reason: 'x', status: 'approved' }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));

    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    const bells = bellsWritten();
    expect(bells).toHaveLength(1);
    expect(oneLine(bells[0])).toContain("'approval', 'Welcome to REASON!'");
    expect(oneLine(bells[0])).not.toMatch(/\bRSN\b/);
  });

  it('says "Welcome to REASON!" when an admin approves from the one-click email', async () => {
    mockQuery.mockImplementation((text: string) => {
      if (/FROM magic_links/.test(text) && /purpose = \$2/.test(text)) {
        return Promise.resolve({ rows: [{
          token_hash: 'h', expires_at: new Date(Date.now() + 3_600_000), used_at: null,
          target_user_id: 'admin-2', target_id: 'jr-1', action: 'approve',
        }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((text: string) => (
      /UPDATE join_requests/.test(text)
        ? Promise.resolve({ rows: [{ id: 'jr-1', full_name: 'Sam Applicant', email: 'sam@example.com' }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));

    const result = await confirmActionToken('a'.repeat(64));
    await flush();

    expect(result.kind).toBe('success');
    const bells = bellsWritten();
    expect(bells).toHaveLength(1);
    expect(oneLine(bells[0])).toContain("'approval', 'Welcome to REASON!'");
    expect(oneLine(bells[0])).not.toMatch(/\bRSN\b/);
  });
});
