// ─── Onboarding v2 endpoints, through the real router ────────────────────────
//
// The services are mocked; the chain is real: authenticate, the rate limit,
// Zod, the handler, the error handler. Mounted the way index.ts mounts it, in
// front of the v1 router, so this also proves neither one shadows the other.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    env: 'test', isDev: false, isProd: false, isTest: true,
    clientUrl: 'https://app.test',
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(async (cb: Function) => cb({ query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }) })),
  __esModule: true,
}));

const mockGetState = jest.fn();
const mockSaveDraft = jest.fn().mockResolvedValue(undefined);
const mockConfirm = jest.fn();
jest.mock('../../services/onboarding/answers-v2.repo', () => ({
  getState: (...a: unknown[]) => mockGetState(...a),
  saveDraft: (...a: unknown[]) => mockSaveDraft(...a),
  confirm: (...a: unknown[]) => mockConfirm(...a),
  __esModule: true,
}));
const mockConnect = jest.fn();
jest.mock('../../services/onboarding/linkedin-v2', () => ({
  connectLinkedin: (...a: unknown[]) => mockConnect(...a),
  __esModule: true,
}));
const mockUsePhoto = jest.fn();
const mockUseShownPhoto = jest.fn();
jest.mock('../../services/onboarding/linkedin-photo', () => ({
  useLinkedinPhoto: (...a: unknown[]) => mockUsePhoto(...a),
  useShownLinkedinPhoto: (...a: unknown[]) => mockUseShownPhoto(...a),
  findLinkedinPhoto: jest.fn().mockResolvedValue(null),
  __esModule: true,
}));
const mockSync = jest.fn();
jest.mock('../../services/matching/first-agent.service', () => ({
  syncSearchesFromV2Answers: (...a: unknown[]) => mockSync(...a),
  createAgentsFromAnswers: jest.fn().mockResolvedValue([]),
  createFirstAgents: jest.fn().mockResolvedValue([]),
  __esModule: true,
}));
const mockNotify = jest.fn().mockResolvedValue(0);
jest.mock('../../services/matching/platform-match.service', () => ({
  notifyMatchesOfNewUser: (...a: unknown[]) => mockNotify(...a),
  __esModule: true,
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutUserEntity: (...a: unknown[]) => mockFanout(...a),
  fanoutAdminEntities: jest.fn().mockResolvedValue(undefined),
  __esModule: true,
}));
const mockStage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/onboarding/stage-events.repo', () => ({
  record: (...a: unknown[]) => mockStage(...a),
  sanitizeErrorMessage: (e: unknown) => String(e),
  __esModule: true,
}));
const mockGravatar = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/onboarding/avatar.service', () => ({
  tryGravatar: (...a: unknown[]) => mockGravatar(...a),
  __esModule: true,
}));
const mockV1GetState = jest.fn();
jest.mock('../../services/onboarding/answers.repo', () => ({
  getState: (...a: unknown[]) => mockV1GetState(...a),
  saveDraft: jest.fn(), confirm: jest.fn(), markTourSeen: jest.fn(),
  __esModule: true,
}));

import onboardingV2Routes from '../../routes/onboarding-v2';
import onboardingRoutes from '../../routes/onboarding';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ValidationError } from '../../middleware/errors';

const app = express();
app.use(express.json());
app.use('/onboarding/v2', onboardingV2Routes);
app.use('/onboarding', onboardingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = jwt.sign({ sub: 'u-1', email: 'u@e.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
// The limiters count per member across this whole file, so a test that sends
// many requests signs in as its own member and never meets another's count.
const authAs = (sub: string) => (r: request.Test) =>
  r.set('Authorization', `Bearer ${jwt.sign({ sub, email: `${sub}@e.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}`);

const ANSWERS = {
  lookingToMeet: ['meet_investors'], meetOther: null,
  hopingToFind: ['find_funding'], findOther: null, findSpecific: null,
  canOffer: ['offer_advice_mentoring'], offerOther: null,
  selfKinds: ['self_founder_owner'], selfOther: null,
};
const STATE = {
  status: 'not_started', version: null, step: 'welcome', answers: ANSWERS, prefilledFromV1: false,
  profile: { displayName: 'Ana', avatarUrl: null, jobTitle: null, company: null, industry: null, timezone: null, linkedinUrl: null },
  linkedin: { status: 'none' },
  tour: { pending: false, seenAt: null, outcome: null },
};
const agent = (id: string, status: string) => ({ id, label: `L-${id}`, status, wantText: 'w', matchingTags: [], userId: 'u-1' });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetState.mockResolvedValue(STATE);
  mockV1GetState.mockResolvedValue({ status: 'not_started', answers: {}, step: 'welcome', displayName: 'Ana', avatarUrl: null, tour: { pending: false, seenAt: null, outcome: null } });
  mockConfirm.mockResolvedValue({ changed: true, firstCompletion: true, answers: ANSWERS });
  mockSync.mockResolvedValue([
    { agent: agent('a-1', 'active'), change: 'created' },
    { agent: agent('a-0', 'paused'), change: 'paused' },
  ]);
  mockConnect.mockResolvedValue({ linkedin: { status: 'searching' }, linkedinUrl: 'https://www.linkedin.com/in/ana', decision: 'start' });
  mockUsePhoto.mockResolvedValue('done');
  mockUseShownPhoto.mockResolvedValue('done');
});

describe('every v2 endpoint needs a signed-in member', () => {
  it.each([
    ['get', '/onboarding/v2/state'],
    ['put', '/onboarding/v2/answers'],
    ['post', '/onboarding/v2/linkedin'],
    ['post', '/onboarding/v2/linkedin/skip'],
    ['post', '/onboarding/v2/confirm'],
  ] as const)('%s %s', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /onboarding/v2/state', () => {
  it('returns the member\'s state, and v1 keeps its own', async () => {
    const res = await auth(request(app).get('/onboarding/v2/state'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: STATE });
    expect(mockGetState).toHaveBeenCalledWith('u-1');
    expect(mockGravatar).toHaveBeenCalledWith('u-1');

    const v1 = await auth(request(app).get('/onboarding/state'));
    expect(v1.status).toBe(200);
    expect(mockV1GetState).toHaveBeenCalledWith('u-1');
    expect(v1.body.data).not.toHaveProperty('linkedin');
  });
});

describe('PUT /onboarding/v2/answers', () => {
  it('saves part of the answers, tells the stage trail and the member\'s other tabs', async () => {
    const res = await auth(request(app).put('/onboarding/v2/answers').send({ lookingToMeet: ['meet_investors'], step: 'q2' }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ saved: true });
    expect(mockSaveDraft).toHaveBeenCalledWith('u-1', { lookingToMeet: ['meet_investors'], step: 'q2' });
    expect(mockStage).toHaveBeenCalledWith('u-1', 'answers_saved', { version: 2, step: 'q2' });
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('refuses an unknown key, a v1 key and an unknown field, saving nothing', async () => {
    for (const body of [{ lookingToMeet: ['astronauts'] }, { canOffer: ['investment'] }, { intent: 'get_advice' }]) {
      const res = await auth(request(app).put('/onboarding/v2/answers').send(body));
      expect(res.status).toBe(400);
    }
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });
});

describe('POST /onboarding/v2/linkedin', () => {
  it('connects, records the stage and returns the linkedin block with the saved address', async () => {
    const res = await auth(request(app).post('/onboarding/v2/linkedin').send({ url: 'linkedin.com/in/Ana/' }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'searching', linkedinUrl: 'https://www.linkedin.com/in/ana' });
    expect(mockConnect).toHaveBeenCalledWith('u-1', 'linkedin.com/in/Ana/');
    expect(mockStage).toHaveBeenCalledWith('u-1', 'linkedin_connected', { lookup: 'start', status: 'searching' });
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('a found profile comes back with its prefill', async () => {
    const prefill = { displayName: 'Ana', photoUrl: null, jobTitle: 'Founder', company: 'Vokt', industry: null, location: null, selfGuess: 'self_founder_owner' };
    mockConnect.mockResolvedValue({ linkedin: { status: 'found', prefill }, linkedinUrl: 'https://www.linkedin.com/in/ana', decision: 'reuse' });
    const res = await auth(request(app).post('/onboarding/v2/linkedin').send({ url: 'https://www.linkedin.com/in/ana' }));
    expect(res.body.data).toEqual({ status: 'found', prefill, linkedinUrl: 'https://www.linkedin.com/in/ana' });
  });

  it('an address that is not a LinkedIn profile is refused in plain words', async () => {
    const message = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';
    mockConnect.mockRejectedValue(new ValidationError(message, { url: [message] }));
    const res = await auth(request(app).post('/onboarding/v2/linkedin').send({ url: 'https://example.com/ana' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(message);
    expect(mockStage).not.toHaveBeenCalled();
  });

  it('needs an address, and says so in words', async () => {
    const res = await auth(request(app).post('/onboarding/v2/linkedin').send({}));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ url: ['Enter your LinkedIn profile link.'] });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('ten tries in ten minutes, then a plain-words wait: every new address can be a paid lookup', async () => {
    const asTrier = authAs('u-many-links');
    for (let i = 0; i < 10; i++) {
      expect((await asTrier(request(app).post('/onboarding/v2/linkedin').send({ url: `linkedin.com/in/a${i}` }))).status).toBe(200);
    }
    const res = await asTrier(request(app).post('/onboarding/v2/linkedin').send({ url: 'linkedin.com/in/a10' }));
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Please wait a few minutes before trying another LinkedIn link.');
    expect(mockConnect).toHaveBeenCalledTimes(10);
  });
});

describe('POST /onboarding/v2/linkedin/skip', () => {
  it('records that they continued with email', async () => {
    const res = await auth(request(app).post('/onboarding/v2/linkedin/skip').send({}));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ skipped: true });
    expect(mockStage).toHaveBeenCalledWith('u-1', 'linkedin_skipped');
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });
});

describe('POST /onboarding/v2/confirm', () => {
  it('a first completion: saves, syncs the searches, tells the network, tells their tabs', async () => {
    const res = await auth(request(app).post('/onboarding/v2/confirm').send({ ...ANSWERS, profile: { timezone: 'Asia/Kathmandu' } }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      changed: true,
      agents: [
        { id: 'a-1', label: 'L-a-1', status: 'active', change: 'created' },
        { id: 'a-0', label: 'L-a-0', status: 'paused', change: 'paused' },
      ],
      primaryAgentId: 'a-1',
      photo: null,
    });
    expect(mockConfirm).toHaveBeenCalledWith('u-1', expect.objectContaining({ lookingToMeet: ['meet_investors'], profile: expect.objectContaining({ timezone: expect.any(String) }) }));
    expect(mockSync).toHaveBeenCalledWith('u-1', ['meet_investors'], null);
    expect(mockStage).toHaveBeenCalledWith('u-1', 'confirmed', { version: 'onboarding_v2', kinds: ['meet_investors'] });
    expect(mockNotify).toHaveBeenCalledWith('u-1');
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('confirming the same answers again changes no search and tells nobody new', async () => {
    mockConfirm.mockResolvedValue({ changed: false, firstCompletion: false, answers: ANSWERS });
    const res = await auth(request(app).post('/onboarding/v2/confirm').send(ANSWERS));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ changed: false, agents: [], primaryAgentId: null, photo: null });
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockFanout).toHaveBeenCalledWith('u-1');
  });

  it('changed answers of a member who finished before: searches synced, the network not told again', async () => {
    mockConfirm.mockResolvedValue({ changed: true, firstCompletion: false, answers: ANSWERS });
    await auth(request(app).post('/onboarding/v2/confirm').send(ANSWERS));
    expect(mockSync).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each([
    ['done', 'used'],
    ['none', 'none'],
    ['failed', 'failed'],
  ])('"Keep this photo": %s becomes %s', async (outcome, photo) => {
    mockUseShownPhoto.mockResolvedValue(outcome);
    const res = await auth(request(app).post('/onboarding/v2/confirm').send({ ...ANSWERS, profile: { useLinkedinPhoto: true } }));
    expect(res.status).toBe(200);
    expect(res.body.data.photo).toBe(photo);
    // Fix round 1 (M1): the photo the prefill showed, never v1's "any photo we hold".
    expect(mockUseShownPhoto).toHaveBeenCalledWith('u-1');
    expect(mockUsePhoto).not.toHaveBeenCalled();
  });

  it('refuses an unfinished set, "Something else" without words, and a made-up time zone', async () => {
    const bad = [
      { ...ANSWERS, selfKinds: [] },
      { ...ANSWERS, lookingToMeet: ['meet_other'], meetOther: '' },
      { ...ANSWERS, profile: { timezone: 'Mars/Base' } },
      { ...ANSWERS, lookingToMeet: ['meet_investors', 'meet_specialists', 'meet_founders_owners', 'meet_students_early_career'] },
    ];
    const asRefused = authAs('u-refused');
    for (const body of bad) {
      const res = await asRefused(request(app).post('/onboarding/v2/confirm').send(body));
      expect(res.status).toBe(400);
    }
    const res = await asRefused(request(app).post('/onboarding/v2/confirm').send({ ...ANSWERS, lookingToMeet: ['meet_other'] }));
    expect(res.body.error.details).toEqual({ meetOther: ['Tell us who you would like to meet.'] });
    // Fix round 1 (M3): a missing question says to answer it, never "Required".
    const { selfKinds: _omitted, ...withoutQ4 } = ANSWERS;
    const missing = await asRefused(request(app).post('/onboarding/v2/confirm').send(withoutQ4));
    expect(missing.body.error.details).toEqual({ selfKinds: ['Select at least one answer.'] });
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
