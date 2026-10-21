// ─── A join request with no LinkedIn address is reviewed like any other (21 Oct 2026) ────
//
// LinkedIn is optional on the request form now, so join_requests.linkedin_url can be NULL (migration 103),
// and an old row can hold an empty string. Nothing that reads the request may break on it:
//   - approving it, from the dashboard or from the one-click email, still approves it and sends the welcome
//     link, and runs NO LinkedIn lookup (the lookup is paid, and has nothing to look up);
//   - the admin queue and the approve page get `linkedinUrl: null` so they can say "No LinkedIn";
//   - one WITH an address still gets its lookup, so these tests would notice a lookup that ran for nobody.

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) =>
    cb({ query: (sql: string, params?: unknown[]) => mockClientQuery(sql, params) }),
  __esModule: true,
}));
jest.mock('../../../config', () => {
  const cfg = { clientUrl: 'https://app.test', apiBaseUrl: 'https://api.test', magicLinkExpiryMinutes: 15 };
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
const mockResolveProvider = jest.fn();
const mockRunProvider = jest.fn();
const mockResultFromOutcome = jest.fn();
jest.mock('../../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => mockResolveProvider(),
  runProvider: (...args: unknown[]) => mockRunProvider(...args),
  resultFromOutcome: (...args: unknown[]) => mockResultFromOutcome(...args),
  __esModule: true,
}));
jest.mock('../../../middleware/auth', () => ({ invalidateUserStatusCache: jest.fn(), __esModule: true }));
jest.mock('../../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import { reviewJoinRequest, listJoinRequests, getJoinRequestById } from '../../../services/join-request/join-request.service';
import { confirmActionToken, peekActionToken } from '../../../services/join-request/admin-action-tokens.service';
import { sendJoinRequestWelcomeEmail } from '../../../services/email/email.service';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const row = (linkedin_url: string | null) => ({
  id: 'jr-1', full_name: 'Jane Doe', email: 'jane@example.com', linkedin_url, reason: 'I run a studio', status: 'approved',
  sign_in_origin: null, reviewed_by: 'admin-1', reviewed_at: new Date('2026-10-21T10:00:00Z'),
  created_at: new Date('2026-10-21T09:00:00Z'), updated_at: new Date('2026-10-21T10:00:00Z'),
});

/** The approval transaction's answers: the claim returns the request, and the account lookups find no account. */
function claim(linkedin_url: string | null) {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [row(linkedin_url)], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const lookups = () => mockRunProvider.mock.calls.length;
const enrichedWrites = () => mockQuery.mock.calls.filter((c) => /UPDATE join_requests SET enriched/.test(String(c[0])));

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset();
  mockResolveProvider.mockReset().mockReturnValue('scrapingdog');
  mockRunProvider.mockReset().mockResolvedValue({ kind: 'ok' });
  // A lookup that finds the person, so a lookup that ran WOULD leave its result on the request.
  mockResultFromOutcome.mockReset().mockReturnValue({
    profile: { fullName: 'Jane Doe' }, confidence: 0.9, sources: [], foundLinkedinUrl: null, enrichedAt: '2026-10-21T10:00:00.000Z',
  });
  (sendJoinRequestWelcomeEmail as jest.Mock).mockClear();
});

describe('approving from the dashboard (reviewJoinRequest)', () => {
  it.each([
    ['NULL (the form left it out)', null],
    ['an empty string (older rows)', ''],
    ['only spaces', '   '],
  ])('a request with LinkedIn %s is approved, gets its welcome email, and runs no lookup', async (_what, stored) => {
    claim(stored);
    const reviewed = await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(reviewed.status).toBe('approved');
    expect(sendJoinRequestWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(lookups()).toBe(0);
    expect(enrichedWrites()).toHaveLength(0);
  });

  it('answers with linkedinUrl null for a request without one', async () => {
    claim(null);
    const reviewed = await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    expect(reviewed.linkedinUrl).toBeNull();
  });

  it('declining one is as before', async () => {
    claim(null);
    const reviewed = await reviewJoinRequest('jr-1', 'declined', 'admin-1');
    await flush();
    expect(reviewed.linkedinUrl).toBeNull();
    expect(lookups()).toBe(0);
  });

  it('a request WITH an address still gets its lookup, with the address in the clean shape (so the tests above can tell)', async () => {
    claim('https://www.linkedin.com/in/jane-doe');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(lookups()).toBe(1);
    expect(mockRunProvider.mock.calls[0][1]).toMatchObject({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe', fullName: 'Jane Doe', email: 'jane@example.com' });
    expect(enrichedWrites()).toHaveLength(1);
  });
});

describe('approving from the one-click email (confirmActionToken)', () => {
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM magic_links/.test(sql) && /purpose = \$2/.test(sql)) {
        return Promise.resolve({ rows: [{
          token_hash: 'h', expires_at: new Date(Date.now() + 3_600_000), used_at: null,
          target_user_id: 'admin-2', target_id: 'jr-1', action: 'approve',
        }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((sql: string) => {
      if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [{ id: 'jr-1', full_name: 'Jane Doe', email: 'jane@example.com', sign_in_origin: null }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  it('approves a request that has no LinkedIn, sends the welcome email, and looks nothing up', async () => {
    const result = await confirmActionToken(TOKEN);
    await flush();

    expect(result).toMatchObject({ kind: 'success', action: 'approve' });
    expect(sendJoinRequestWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(lookups()).toBe(0);
  });

  it('never needs the address: the approval does not even read the column', async () => {
    await confirmActionToken(TOKEN);
    const claimSql = String(mockClientQuery.mock.calls.find((c) => /UPDATE join_requests/.test(String(c[0])))![0]);
    expect(claimSql).not.toMatch(/linkedin/i);
  });
});

describe('what the admin screens are sent', () => {
  it('the approve page gets linkedinUrl null for a request without one, and the address when there is one', async () => {
    const peek = (linkedin_url: string | null) => {
      mockQuery.mockImplementation((sql: string) => {
        if (/FROM magic_links/.test(sql) && /purpose = \$2/.test(sql)) {
          return Promise.resolve({ rows: [{
            token_hash: 'h', expires_at: new Date(Date.now() + 3_600_000), used_at: null,
            target_user_id: 'admin-2', target_id: 'jr-1', action: 'approve',
          }], rowCount: 1 });
        }
        if (/FROM join_requests jr/.test(sql)) {
          return Promise.resolve({ rows: [{ ...row(linkedin_url), status: 'pending', reviewer_name: null }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      return peekActionToken('a'.repeat(64));
    };

    expect(await peek(null)).toMatchObject({ kind: 'ready', request: { fullName: 'Jane Doe', linkedinUrl: null } });
    expect(await peek('https://www.linkedin.com/in/jane-doe')).toMatchObject({ kind: 'ready', request: { linkedinUrl: 'https://www.linkedin.com/in/jane-doe' } });
  });

  it('the queue and a single request carry linkedinUrl null for a request without one', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT COUNT\(\*\) FROM join_requests/.test(sql)) return Promise.resolve({ rows: [{ count: '2' }], rowCount: 1 });
      if (/FROM join_requests jr/.test(sql)) {
        return Promise.resolve({ rows: [{ ...row(null), status: 'pending' }, { ...row('https://www.linkedin.com/in/jane-doe'), id: 'jr-2', status: 'pending' }], rowCount: 2 });
      }
      if (/SELECT \* FROM join_requests WHERE id/.test(sql)) return Promise.resolve({ rows: [row(null)], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const { requests, total } = await listJoinRequests({ status: 'pending' });
    expect(total).toBe(2);
    expect(requests.map((r) => r.linkedinUrl)).toEqual([null, 'https://www.linkedin.com/in/jane-doe']);
    expect((await getJoinRequestById('jr-1')).linkedinUrl).toBeNull();
  });
});
