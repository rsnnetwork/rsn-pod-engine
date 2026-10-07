// ─── A join request remembers the site it was made on, and its emails open there ──
// (7 Oct 2026)
//
// Someone who asks to join on the preview and is approved used to get an email whose
// link opened the live app. The request now remembers the site it was made on
// (join_requests.sign_in_origin), and every link the APPLICANT receives (the approval
// link, the fallback login link, the reminders, and the one-click email approval's link)
// opens there. Links for ADMINS (the dashboard, the approve and reject buttons) stay on
// the main app. Only one of our own sites is ever stored or used.
//
// The real services run; only the database, the emails and what they pull in are stand-ins.

import crypto from 'crypto';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockClientQuery(sql, params) }),
  __esModule: true,
}));
jest.mock('../../../config', () => {
  // As in production: the main app is app.rsn.network, so the preview is a different site of ours.
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

import {
  createJoinRequest, reviewJoinRequest, pokeJoinRequest, processAutoReminders,
} from '../../../services/join-request/join-request.service';
import { confirmActionToken, issueReviewTokens } from '../../../services/join-request/admin-action-tokens.service';
import {
  sendJoinRequestConfirmationEmail, sendJoinRequestWelcomeEmail, sendJoinRequestReminderEmail, sendJoinRequestAdminReviewEmail,
} from '../../../services/email/email.service';

const MAIN = 'https://app.rsn.network';
const PREVIEW = 'https://preview.rsn.network';
const DAY = 24 * 60 * 60 * 1000;

// Values a stored column could hold that are not ours (or are ours only in development).
const NOT_OURS = ['https://evil.example', 'https://preview.rsn.network.evil.example', 'javascript:alert(1)', 'http://localhost:5173'];

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const sql = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ');

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockClientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Making a request ─────────────────────────────────────────────────────────

const INPUT = { fullName: 'Sam Applicant', email: 'sam@example.com', linkedinUrl: 'https://www.linkedin.com/in/sam', reason: 'I run a studio' };

function theDatabaseAcceptsARequest() {
  mockQuery.mockImplementation((text: string, params: unknown[] = []) => {
    if (/SELECT id FROM join_requests WHERE email/.test(text)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO join_requests/.test(text)) {
      return Promise.resolve({ rows: [{
        id: 'jr-1', full_name: params[0], email: params[1], linkedin_url: params[2], reason: params[3], status: 'pending', sign_in_origin: params[4],
      }] });
    }
    if (/FROM users WHERE role IN/.test(text)) return Promise.resolve({ rows: [{ id: 'admin-1', email: 'admin@rsn.network', display_name: 'Ada' }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}
const insertCall = () => mockQuery.mock.calls.find((c) => /INSERT INTO join_requests/.test(String(c[0])))!;

describe('createJoinRequest remembers the site the request was made on', () => {
  it('stores the preview when the request came from it', async () => {
    theDatabaseAcceptsARequest();
    await createJoinRequest(INPUT, PREVIEW);
    expect(insertCall()[1]).toEqual([INPUT.fullName, INPUT.email, INPUT.linkedinUrl, INPUT.reason, PREVIEW]);
  });

  it('stores nothing for the main app, so the live app is exactly as before', async () => {
    theDatabaseAcceptsARequest();
    await createJoinRequest(INPUT, MAIN);
    expect((insertCall()[1] as unknown[])[4]).toBeNull();
  });

  it.each([undefined, '', 'https://evil.example', 'https://preview.rsn.network.evil.example', 'http://localhost:5173', 'null'])(
    'stores nothing for an Origin of %j',
    async (origin) => {
      theDatabaseAcceptsARequest();
      await createJoinRequest(INPUT, origin);
      expect((insertCall()[1] as unknown[])[4]).toBeNull();
    },
  );

  it('changes nothing else about the request: same columns, same first four values, same answer', async () => {
    theDatabaseAcceptsARequest();
    const created = await createJoinRequest(INPUT, PREVIEW);

    expect(sql(insertCall())).toBe(
      'INSERT INTO join_requests (full_name, email, linkedin_url, reason, sign_in_origin) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    );
    // The answer is the request, as before: it does not carry the site.
    expect(created).toMatchObject({ id: 'jr-1', fullName: INPUT.fullName, email: INPUT.email, status: 'pending' });
    expect(created).not.toHaveProperty('signInOrigin');
    expect(created).not.toHaveProperty('sign_in_origin');
    await flush();
    expect(sendJoinRequestConfirmationEmail).toHaveBeenCalledWith(INPUT.email, INPUT.fullName);
  });

  it('still refuses a second pending request, and stores nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jr-0' }] });
    await expect(createJoinRequest(INPUT, PREVIEW)).rejects.toMatchObject({ statusCode: 409, message: 'You already have a pending request.' });
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO join_requests/.test(String(c[0])))).toBe(false);
  });

  it('keeps the links an ADMIN gets on the main app, even for a request made on the preview', async () => {
    theDatabaseAcceptsARequest();
    await createJoinRequest(INPUT, PREVIEW);
    await flush();

    expect(sendJoinRequestAdminReviewEmail).toHaveBeenCalledTimes(1);
    const [to, mail] = (sendJoinRequestAdminReviewEmail as jest.Mock).mock.calls[0];
    expect(to).toBe('admin@rsn.network');
    expect(mail.dashboardUrl).toBe(`${MAIN}/admin/join-requests`);
    expect(mail.approveUrl).toMatch(/^https:\/\/app\.rsn\.network\/admin\/jr\/[0-9a-f]{64}$/);
    expect(mail.rejectUrl).toMatch(/^https:\/\/app\.rsn\.network\/admin\/jr\/[0-9a-f]{64}$/);
  });

  it('issueReviewTokens builds the admin buttons on the main app', async () => {
    const issued = await issueReviewTokens('jr-1', [{ id: 'admin-1', email: 'admin@rsn.network' }]);
    const pair = issued.get('admin-1')!;
    expect(pair.approveUrl).toBe(`${MAIN}/admin/jr/${pair.approveToken}`);
    expect(pair.rejectUrl).toBe(`${MAIN}/admin/jr/${pair.rejectToken}`);
  });
});

// ── Approving from the dashboard ─────────────────────────────────────────────

/** The row an approval claims. `signInOrigin` undefined is a request from before the column existed. */
const approvedRow = (signInOrigin?: string | null) => ({
  id: 'jr-1', full_name: 'Sam Applicant', email: 'Sam@Example.com', linkedin_url: null, reason: 'x', status: 'approved',
  ...(signInOrigin === undefined ? {} : { sign_in_origin: signInOrigin }),
});

function adminApproves(row: Record<string, unknown>) {
  mockClientQuery.mockImplementation((text: string) => (
    /UPDATE join_requests/.test(text) ? Promise.resolve({ rows: [row], rowCount: 1 }) : Promise.resolve({ rows: [], rowCount: 0 })
  ));
}
const welcomeLink = () => String((sendJoinRequestWelcomeEmail as jest.Mock).mock.calls[0][2]);
const storedLogin = () => mockQuery.mock.calls.find((c) => /INSERT INTO magic_links/.test(String(c[0])))!;
const tokenIn = (url: string) => new URL(url).searchParams.get('token')!;

describe('approving from the dashboard (reviewJoinRequest)', () => {
  it('opens the preview for someone who asked on the preview', async () => {
    adminApproves(approvedRow(PREVIEW));
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    expect(welcomeLink()).toMatch(/^https:\/\/preview\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it.each([null, undefined])('opens the main app, exactly as before, when the request remembers no site (%s)', async (stored) => {
    adminApproves(approvedRow(stored));
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    expect(welcomeLink()).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it.each(NOT_OURS)('opens the main app when the stored value is %j, which is not ours', async (stored) => {
    adminApproves(approvedRow(stored));
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    expect(welcomeLink()).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  // Only the host in the link changes. The link is the same single-use, 7-day login link in the same table.
  it.each([[PREVIEW], [null]])('stores the login link exactly as before (site %j): same table, same hash, same 7-day expiry', async (stored) => {
    adminApproves(approvedRow(stored));
    const before = Date.now();
    await reviewJoinRequest('jr-1', 'approved', 'admin-1');

    const [text, params] = storedLogin() as [string, [string, string, Date]];
    expect(text.replace(/\s+/g, ' ')).toBe('INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, $3)');
    expect(params[0]).toBe('sam@example.com');
    expect(params[1]).toBe(sha256(tokenIn(welcomeLink())));
    expect(params[2].getTime()).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
    expect(params[2].getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);
    const retired = mockQuery.mock.calls.find((c) => /UPDATE magic_links SET used_at = NOW\(\)/.test(String(c[0])))!;
    expect(sql(retired)).toBe("UPDATE magic_links SET used_at = NOW() WHERE email = $1 AND purpose = 'login' AND used_at IS NULL AND expires_at > NOW()");
    expect(retired[1]).toEqual(['sam@example.com']);
  });

  it.each([[PREVIEW, `${PREVIEW}/login`], [null, `${MAIN}/login`]])(
    'when the link cannot be made (site %j), the fallback is the login page of that same site',
    async (stored, expected) => {
      adminApproves(approvedRow(stored));
      mockQuery.mockImplementation((text: string) => (
        /INSERT INTO magic_links/.test(text) ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [], rowCount: 0 })
      ));
      await reviewJoinRequest('jr-1', 'approved', 'admin-1');
      expect(welcomeLink()).toBe(expected);
    },
  );

  it('the answer to the admin does not carry the site', async () => {
    adminApproves(approvedRow(PREVIEW));
    const reviewed = await reviewJoinRequest('jr-1', 'approved', 'admin-1');
    expect(reviewed).toMatchObject({ id: 'jr-1', status: 'approved' });
    expect(reviewed).not.toHaveProperty('signInOrigin');
    expect(reviewed).not.toHaveProperty('sign_in_origin');
  });
});

// ── Approving from the email ─────────────────────────────────────────────────

describe('approving from the one-click email (confirmActionToken)', () => {
  const TOKEN = 'a'.repeat(64);

  function adminClicksApprove(signInOrigin?: string | null) {
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
        ? Promise.resolve({
          rows: [{ id: 'jr-1', full_name: 'Sam Applicant', email: 'sam@example.com', ...(signInOrigin === undefined ? {} : { sign_in_origin: signInOrigin }) }],
          rowCount: 1,
        })
        : Promise.resolve({ rows: [], rowCount: 0 })
    ));
  }

  it('reads the remembered site in the same claim that approves the request', async () => {
    adminClicksApprove(PREVIEW);
    await confirmActionToken(TOKEN);
    const claim = mockClientQuery.mock.calls.find((c) => /UPDATE join_requests/.test(String(c[0])))!;
    expect(sql(claim)).toMatch(/WHERE id = \$3 AND status = 'pending' RETURNING id, full_name, email, sign_in_origin$/);
  });

  it('opens the preview for someone who asked on the preview', async () => {
    adminClicksApprove(PREVIEW);
    const result = await confirmActionToken(TOKEN);
    await flush();
    expect(result.kind).toBe('success');
    expect(welcomeLink()).toMatch(/^https:\/\/preview\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it.each([null, undefined])('opens the main app, exactly as before, when the request remembers no site (%s)', async (stored) => {
    adminClicksApprove(stored);
    await confirmActionToken(TOKEN);
    await flush();
    expect(welcomeLink()).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it.each(NOT_OURS)('opens the main app when the stored value is %j, which is not ours', async (stored) => {
    adminClicksApprove(stored);
    await confirmActionToken(TOKEN);
    await flush();
    expect(welcomeLink()).toMatch(/^https:\/\/app\.rsn\.network\/auth\/verify\?token=[0-9a-f]{64}$/);
  });

  it('stores the login link exactly as before, and answers the click as before', async () => {
    adminClicksApprove(PREVIEW);
    const result = await confirmActionToken(TOKEN);
    await flush();

    const [text, params] = storedLogin() as [string, [string, string, Date]];
    expect(text.replace(/\s+/g, ' ')).toBe("INSERT INTO magic_links (email, token_hash, expires_at, purpose) VALUES ($1, $2, $3, 'login')");
    expect(params[0]).toBe('sam@example.com');
    expect(params[1]).toBe(sha256(tokenIn(welcomeLink())));
    expect(result).toEqual({ kind: 'success', action: 'approve', request: { id: 'jr-1', fullName: 'Sam Applicant', email: 'sam@example.com' } });
  });
});

// ── Reminders ────────────────────────────────────────────────────────────────

describe('reminders to an approved applicant', () => {
  const waiting = (signInOrigin?: string | null, extra: Record<string, unknown> = {}) => ({
    ...approvedRow(signInOrigin), reminder_count: 0, last_reminded_at: null, reviewed_at: new Date(Date.now() - 4 * DAY), ...extra,
  });

  function approvedAndNotSignedUp(row: Record<string, unknown>) {
    mockQuery.mockImplementation((text: string) => {
      if (/SELECT \* FROM join_requests WHERE id/.test(text)) return Promise.resolve({ rows: [row] });
      if (/SELECT jr\.\* FROM join_requests jr/.test(text.replace(/\s+/g, ' '))) return Promise.resolve({ rows: [row] });
      if (/FROM users WHERE LOWER\(email\)/.test(text)) return Promise.resolve({ rows: [] }); // not signed up yet
      if (/UPDATE join_requests SET last_reminded_at/.test(text.replace(/\s+/g, ' '))) {
        return Promise.resolve({ rows: [{ ...row, reminder_count: 1, last_reminded_at: new Date() }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  }
  const reminder = () => (sendJoinRequestReminderEmail as jest.Mock).mock.calls[0];

  it('a poke from an admin opens the login page of the site the applicant asked on', async () => {
    approvedAndNotSignedUp(waiting(PREVIEW));
    await pokeJoinRequest('jr-1');
    expect(reminder()).toEqual(['Sam@Example.com', 'Sam Applicant', `${PREVIEW}/login`, 1]);
  });

  it.each([null, undefined])('a poke for a request that remembers no site opens the main app, as before (%s)', async (stored) => {
    approvedAndNotSignedUp(waiting(stored));
    await pokeJoinRequest('jr-1');
    expect(reminder()).toEqual(['Sam@Example.com', 'Sam Applicant', `${MAIN}/login`, 1]);
  });

  it.each(NOT_OURS)('a stored value of %j, which is not ours, opens the main app', async (stored) => {
    approvedAndNotSignedUp(waiting(stored));
    await pokeJoinRequest('jr-1');
    expect(reminder()[2]).toBe(`${MAIN}/login`);
  });

  it('the automatic reminder (day 3) goes the same way', async () => {
    approvedAndNotSignedUp(waiting(PREVIEW));
    const result = await processAutoReminders();
    expect(result).toEqual({ reminded: 1, expired: 0 });
    expect(reminder()[2]).toBe(`${PREVIEW}/login`);
  });

  it('still keeps the 24-hour pause, and sends nothing inside it', async () => {
    approvedAndNotSignedUp(waiting(PREVIEW, { last_reminded_at: new Date(Date.now() - 2 * 60 * 60 * 1000), reminder_count: 1 }));
    await expect(pokeJoinRequest('jr-1')).rejects.toMatchObject({ statusCode: 429 });
    expect(sendJoinRequestReminderEmail).not.toHaveBeenCalled();
  });
});
