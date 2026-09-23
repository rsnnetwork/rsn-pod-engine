// ─── Approving a join request reopens a closed account (23 Sep 2026) ────────
//
// Shradha's deleted account stayed closed after an admin approved her new
// request, so she could not get in. Approval now reopens a CLOSED account with
// that email in the same transaction as the approval, before the welcome link
// goes out, on BOTH ways an admin can approve (the dashboard and the one-click
// email). Suspended and banned are moderation decisions: approval leaves them
// alone and sends no "you're in" email it cannot honour.

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

import { reviewJoinRequest } from '../../../services/join-request/join-request.service';
import { confirmActionToken } from '../../../services/join-request/admin-action-tokens.service';
import { sendJoinRequestWelcomeEmail } from '../../../services/email/email.service';
import { invalidateUserStatusCache } from '../../../middleware/auth';
import { recordAudit } from '../../../middleware/audit';
import { fanoutAdminEntities, fanoutUserEntity } from '../../../realtime/fanout';

const REQUEST = { id: 'jr-1', full_name: 'Shradha', email: 'Shradha@Vokt.ai', linkedin_url: null, reason: 'x', status: 'approved' };
const REOPEN = /UPDATE users SET status = 'active'/;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** The transaction's answers, in order: the join_requests UPDATE, then what the account turns out to be. */
function accountIs(kind: 'closed' | 'none' | 'suspended' | 'banned', joinRow: Record<string, unknown> = REQUEST) {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [joinRow], rowCount: 1 });
    if (REOPEN.test(sql)) return Promise.resolve(kind === 'closed' ? { rows: [{ id: 'user-9' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    if (/UPDATE refresh_tokens/.test(sql)) return Promise.resolve({ rows: [], rowCount: 2 });
    if (/status IN \('suspended', 'banned'\)/.test(sql)) {
      return Promise.resolve(kind === 'suspended' || kind === 'banned' ? { rows: [{ status: kind }], rowCount: 1 } : { rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const txSql = () => mockClientQuery.mock.calls.map((c) => String(c[0]));
const reopenCall = () => mockClientQuery.mock.calls.find((c) => REOPEN.test(String(c[0])));

beforeEach(() => {
  log.length = 0;
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('dashboard approval (reviewJoinRequest)', () => {
  it('reopens a closed account in the approval transaction, before the welcome link exists', async () => {
    accountIs('closed');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    const reopenAt = log.findIndex((l) => REOPEN.test(l));
    const commitAt = log.indexOf('tx:commit');
    const linkAt = log.findIndex((l) => /INSERT INTO magic_links/.test(l));
    expect(reopenAt).toBeGreaterThan(log.indexOf('tx:begin'));
    expect(reopenAt).toBeLessThan(commitAt);
    expect(linkAt).toBeGreaterThan(commitAt);
    expect(sendJoinRequestWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it('only ever reopens a CLOSED account, matched on the email whatever its case', async () => {
    accountIs('closed');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');

    const [sql, params] = reopenCall()!;
    expect(String(sql)).toMatch(/WHERE LOWER\(email\) = LOWER\(\$1\) AND status = 'deactivated'/);
    expect(params).toEqual(['Shradha@Vokt.ai']);
  });

  it('revokes sessions from before the account was closed', async () => {
    accountIs('closed');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');

    const revoke = mockClientQuery.mock.calls.find((c) => /UPDATE refresh_tokens SET revoked_at/.test(String(c[0])));
    expect(revoke![1]).toEqual(['user-9']);
  });

  it('then drops the cached "closed", tells every screen, and leaves an audit record naming the admin', async () => {
    accountIs('closed');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');

    expect(invalidateUserStatusCache).toHaveBeenCalledWith('user-9');
    expect(fanoutAdminEntities).toHaveBeenCalledWith('users');
    expect(fanoutUserEntity).toHaveBeenCalledWith('user-9');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1', action: 'user.reopened_by_approval', entityType: 'user', entityId: 'user-9',
      details: expect.objectContaining({ joinRequestId: 'jr-1', via: 'dashboard' }),
    }));
  });

  it('a brand-new applicant is approved exactly as before', async () => {
    accountIs('none');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(invalidateUserStatusCache).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(sendJoinRequestWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['suspended', 'banned'] as const)('a %s account stays blocked and gets no "you are in" email or notification', async (kind) => {
    accountIs(kind);
    const reviewed = await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(reviewed.status).toBe('approved');
    expect(invalidateUserStatusCache).not.toHaveBeenCalled();
    expect(sendJoinRequestWelcomeEmail).not.toHaveBeenCalled();
    expect(log.some((l) => /INSERT INTO magic_links/.test(l))).toBe(false);
    expect(log.some((l) => /INSERT INTO notifications/.test(l))).toBe(false);
  });

  it('declining never touches the account', async () => {
    accountIs('closed', { ...REQUEST, status: 'declined' });
    await reviewJoinRequest('jr-1', 'declined', 'admin-1');

    expect(txSql().some((s) => REOPEN.test(s))).toBe(false);
    expect(invalidateUserStatusCache).not.toHaveBeenCalled();
  });

  // 23 Sep 2026: Ali double-clicked Approve. Both clicks ran the whole approval
  // 300ms apart: two welcome emails, and the second one's link killed the
  // first's ("already used"). The approval now claims only a PENDING request.
  it('the approval only claims a request that is still pending', async () => {
    accountIs('none');
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    const claim = mockClientQuery.mock.calls.find((c) => /UPDATE join_requests/.test(String(c[0])));
    expect(String(claim![0])).toMatch(/WHERE id = \$4 AND status = 'pending'/);
  });

  it('a second click on Approve sends nothing again: no email, no new link, no reopen', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 }); // the first click already claimed it
      if (/SELECT \* FROM join_requests WHERE id/.test(sql)) return Promise.resolve({ rows: [REQUEST], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const reviewed = await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    await flush();

    expect(reviewed.status).toBe('approved');
    expect(sendJoinRequestWelcomeEmail).not.toHaveBeenCalled();
    expect(log.some((l) => /INSERT INTO magic_links|UPDATE magic_links/.test(l))).toBe(false);
    expect(log.some((l) => /INSERT INTO notifications/.test(l))).toBe(false);
    expect(txSql().some((s) => REOPEN.test(s))).toBe(false);
  });

  it('approving a request another admin already declined is refused, and says so', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/UPDATE join_requests/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (/SELECT \* FROM join_requests WHERE id/.test(sql)) return Promise.resolve({ rows: [{ ...REQUEST, status: 'declined' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(reviewJoinRequest('jr-1', 'approved', 'admin-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'JOIN_REQUEST_ALREADY_REVIEWED', message: 'This request was already declined.' });
    expect(sendJoinRequestWelcomeEmail).not.toHaveBeenCalled();
  });

  it('a missing request is still a 404, and nothing is reopened', async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(reviewJoinRequest('jr-x', 'approved', 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(txSql().some((s) => REOPEN.test(s))).toBe(false);
  });
});

describe('one-click email approval (confirmActionToken)', () => {
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
  });

  it('reopens a closed account in the approval transaction too', async () => {
    accountIs('closed', { id: 'jr-1', full_name: 'Shradha', email: 'shradha@vokt.ai' });
    const result = await confirmActionToken(TOKEN);
    await flush();

    expect(result.kind).toBe('success');
    const reopenAt = log.findIndex((l) => REOPEN.test(l));
    expect(reopenAt).toBeGreaterThan(log.indexOf('tx:begin'));
    expect(reopenAt).toBeLessThan(log.indexOf('tx:commit'));
    expect(invalidateUserStatusCache).toHaveBeenCalledWith('user-9');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-2', action: 'user.reopened_by_approval', details: expect.objectContaining({ via: 'email_action' }),
    }));
    expect(sendJoinRequestWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it('and now tells every open admin queue, as the dashboard path does', async () => {
    accountIs('none', { id: 'jr-1', full_name: 'Shradha', email: 'shradha@vokt.ai' });
    await confirmActionToken(TOKEN);
    expect(fanoutAdminEntities).toHaveBeenCalledWith('join-requests');
  });

  it('a suspended account stays blocked and gets no welcome email', async () => {
    accountIs('suspended', { id: 'jr-1', full_name: 'Shradha', email: 'shradha@vokt.ai' });
    await confirmActionToken(TOKEN);
    await flush();
    expect(sendJoinRequestWelcomeEmail).not.toHaveBeenCalled();
  });

  it('a request someone already reviewed reopens nothing', async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await confirmActionToken(TOKEN);
    expect(result.kind).toBe('already_processed');
    expect(txSql().some((s) => REOPEN.test(s))).toBe(false);
  });
});
