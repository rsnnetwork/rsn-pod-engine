// ─── POST /join-requests: LinkedIn is optional (21 Oct 2026) ─────────────────
//
// The client, 19 Oct: "LinkedIn should not be required. Recommend LinkedIn, but let people add it later."
// So the request form may send no LinkedIn address at all. When it sends one it must be a LinkedIn profile,
// and it is stored in one shape. The live form (the main app) always sends https://linkedin.com/in/<name>
// and ignores the answer, so it must keep working exactly as it does.
//
// These go through express with the real router, schema and service; only the database and the emails are
// stand-ins.

import express from 'express';
import request from 'supertest';

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 15,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  __esModule: true,
}));
jest.mock('../../services/email/email.service', () => ({
  sendJoinRequestConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestDeclineEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestReminderEmail: jest.fn().mockResolvedValue(undefined),
  sendJoinRequestAdminReviewEmail: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
jest.mock('../../services/onboarding/providers/registry', () => ({
  resolveEnrichProvider: () => 'none',
  runProvider: jest.fn(),
  resultFromOutcome: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/onboarding/enrichment.service', () => ({
  applyMatchVerification: jest.fn(),
  normalizeLinkedinUrl: jest.fn(),
  __esModule: true,
}));
jest.mock('../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  fanoutUserEntity: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import joinRequestRoutes from '../../routes/join-requests';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/join-requests', joinRequestRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const HELP = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';
const STORED = 'https://www.linkedin.com/in/jane-doe';
const PERSON = { fullName: 'Jane Doe', email: 'jane@example.com', reason: 'I run a studio and want to meet people who fund them' };

beforeEach(() => {
  mockQuery.mockReset().mockImplementation((text: string, params: unknown[] = []) => {
    if (/SELECT id FROM join_requests WHERE email/.test(text)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO join_requests/.test(text)) {
      return Promise.resolve({ rows: [{
        id: 'jr-1', full_name: params[0], email: params[1], linkedin_url: params[2], reason: params[3], status: 'pending', sign_in_origin: params[4],
        created_at: new Date('2026-10-21T10:00:00Z'), updated_at: new Date('2026-10-21T10:00:00Z'),
      }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

const submit = (body: object) => request(app).post('/join-requests').send(body);
const insert = () => mockQuery.mock.calls.find((c) => /INSERT INTO join_requests/.test(String(c[0])));
const storedLinkedin = () => (insert()![1] as unknown[])[2];

describe('POST /join-requests: no LinkedIn address', () => {
  it.each([
    ['is left out', {}],
    ['is null', { linkedinUrl: null }],
    ['is an empty string', { linkedinUrl: '' }],
    ['is only spaces', { linkedinUrl: '   ' }],
    ['is only a tab and a newline', { linkedinUrl: '\t\n ' }],
  ])('takes the request when LinkedIn %s, and stores NULL', async (_what, extra) => {
    const res = await submit({ ...PERSON, ...extra });
    expect(res.status).toBe(201);
    expect(storedLinkedin()).toBeNull();
    expect(res.body.data).toMatchObject({ id: 'jr-1', fullName: 'Jane Doe', status: 'pending', linkedinUrl: null });
  });

  it('still asks for everything else: the name, an email that is an email, and the reason', async () => {
    expect((await submit({ email: PERSON.email, reason: PERSON.reason })).status).toBe(400);
    expect((await submit({ fullName: PERSON.fullName, reason: PERSON.reason })).status).toBe(400);
    expect((await submit({ ...PERSON, email: 'not-an-email' })).status).toBe(400);
    expect((await submit({ fullName: PERSON.fullName, email: PERSON.email })).status).toBe(400);
    expect((await submit({ ...PERSON, reason: '' })).status).toBe(400);
    expect((await submit({ ...PERSON, reason: 'x'.repeat(1001) })).status).toBe(400);
    expect(insert()).toBeUndefined();
  });
});

describe('POST /join-requests: a LinkedIn address is stored in one shape', () => {
  it.each([
    ['https://linkedin.com/in/jane-doe', 'what the live form sends'],
    ['https://www.linkedin.com/in/jane-doe', 'www.'],
    ['http://www.linkedin.com/in/jane-doe', 'http://'],
    ['http://linkedin.com/in/jane-doe', 'http:// without www.'],
    ['https://www.linkedin.com/in/jane-doe/', 'a trailing slash'],
    ['https://www.linkedin.com/in/jane-doe?utm_source=share&utm_medium=member_ios', 'a query string'],
    ['https://uk.linkedin.com/in/jane-doe?x=1', 'another country'],
    ['https://www.linkedin.com/in/jane-doe/details/experience/', 'a page under the profile'],
    ['linkedin.com/in/jane-doe', 'no scheme'],
    ['  https://linkedin.com/in/jane-doe  ', 'spaces around it'],
  ])('%s (%s) is stored as the clean profile address', async (typed) => {
    const res = await submit({ ...PERSON, linkedinUrl: typed });
    expect(res.status).toBe(201);
    expect(storedLinkedin()).toBe(STORED);
    expect(res.body.data.linkedinUrl).toBe(STORED);
  });

  it('keeps the name as it was written', async () => {
    const res = await submit({ ...PERSON, linkedinUrl: 'https://linkedin.com/in/Ali-Hamza-b0650a281' });
    expect(res.status).toBe(201);
    expect(storedLinkedin()).toBe('https://www.linkedin.com/in/Ali-Hamza-b0650a281');
  });

  it('is exactly the live form: its payload still gets a 201 and the same answer, with the address in the clean shape', async () => {
    const res = await submit({ fullName: 'Ali Live', email: 'ali.live@example.com', linkedinUrl: 'https://linkedin.com/in/ali-live', reason: 'I saw it on the live site' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: 'jr-1', fullName: 'Ali Live', email: 'ali.live@example.com', reason: 'I saw it on the live site', status: 'pending',
      linkedinUrl: 'https://www.linkedin.com/in/ali-live',
    });
  });
});

describe('POST /join-requests: an address that is not a LinkedIn profile is refused', () => {
  it.each([
    'https://example.com/not-a-linkedin-profile',
    'https://example.com/in/jane-doe',
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/in/',
    'https://linkedin.com.evil.example/in/jane-doe',
    'https://evil-linkedin.com/in/jane-doe',
    'https://linkedin.com@evil.example/in/jane-doe',
    'javascript:alert(1)',
    'ftp://linkedin.com/in/jane-doe',
    'jane-doe',
    'not a url',
    'https://www.linkedin.com/in/jane doe',
  ])('%s: a 400 that says what to enter, and nothing stored', async (typed) => {
    const res = await submit({ ...PERSON, linkedinUrl: typed });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.details).toEqual({ linkedinUrl: [HELP] });
    expect(insert()).toBeUndefined();
  });

  it('is not a way round the length limit: 500 characters at most', async () => {
    const atTheLimit = `https://linkedin.com/in/${'a'.repeat(500 - 'https://linkedin.com/in/'.length)}`;
    expect(atTheLimit).toHaveLength(500);
    expect((await submit({ ...PERSON, linkedinUrl: atTheLimit })).status).toBe(201);

    mockQuery.mockClear();
    const res = await submit({ ...PERSON, linkedinUrl: `${atTheLimit}a` });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('linkedinUrl');
    expect(insert()).toBeUndefined();
  });

  it.each([
    ['a number', 42],
    ['an object', { url: 'https://linkedin.com/in/jane-doe' }],
    ['a list', ['https://linkedin.com/in/jane-doe']],
    ['true', true],
  ])('refuses %s in the place of an address', async (_what, value) => {
    const res = await submit({ ...PERSON, linkedinUrl: value });
    expect(res.status).toBe(400);
    expect(insert()).toBeUndefined();
  });
});
