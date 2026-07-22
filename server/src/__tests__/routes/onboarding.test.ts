// ─── /onboarding chatbot route tests ────────────────────────────────────────
// Covers auth, validation, the LLM-disabled form-fallback (503), and that
// /confirm runs extraction → save → returns the gate result. The service and
// repo are mocked; the real auth/validate/rate-limit middleware run.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET,
    env: 'test',
    isDev: false,
    isProd: false,
    isTest: true,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1000,
  },
  __esModule: true,
}));

jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/redis/redis.client', () => ({
  getRedisClient: () => null,
  __esModule: true,
}));

jest.mock('../../services/onboarding/chatbot.service', () => ({
  isEnabled: jest.fn(),
  converse: jest.fn(),
  extractIntent: jest.fn(),
  liveProfileFromIntent: jest.fn(() => null),
  __esModule: true,
}));

jest.mock('../../services/onboarding/intent.repo', () => ({
  getOnboardingStatus: jest.fn(),
  markInProgress: jest.fn(),
  saveIntentAndComplete: jest.fn(),
  savePartialIntent: jest.fn(),
  getResume: jest.fn(),
  getKnownProfileForHost: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/onboarding/known', () => ({
  inferKnownProfile: jest.fn(),
  __esModule: true,
}));

jest.mock('../../services/onboarding/enrichment.repo', () => ({
  getCachedEnrichment: jest.fn(),
  saveEnrichedCandidate: jest.fn(),
  setEnrichmentState: jest.fn(),
  clearEnrichment: jest.fn(),
  applyEnrichedToProfile: jest.fn(),
  __esModule: true,
}));

// runEnrichment is the background job — stubbed here so route tests only
// assert it was FIRED (fire-and-forget), never awaited. isFreshCacheHit is
// the one bit of real (pure) logic the route depends on for its 202-vs-200
// decision, so it runs for real via requireActual.
jest.mock('../../services/onboarding/enrichment.orchestrator', () => {
  const actual = jest.requireActual('../../services/onboarding/enrichment.orchestrator');
  return {
    isFreshCacheHit: actual.isFreshCacheHit,
    runEnrichment: jest.fn().mockResolvedValue(undefined),
    __esModule: true,
  };
});

import { query as dbQuery } from '../../db';
import config from '../../config';
import onboardingRoutes from '../../routes/onboarding';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as chatbot from '../../services/onboarding/chatbot.service';
import * as intentRepo from '../../services/onboarding/intent.repo';
import * as known from '../../services/onboarding/known';
import * as enrichRepo from '../../services/onboarding/enrichment.repo';
import { runEnrichment } from '../../services/onboarding/enrichment.orchestrator';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/onboarding', onboardingRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(userId = 'user-abc') {
  return jwt.sign(
    { sub: userId, email: 'u@e.com', role: 'member', sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  // authenticate's status check + any stray db call default to an active user.
  (dbQuery as jest.Mock).mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  (intentRepo.markInProgress as jest.Mock).mockResolvedValue(undefined);
  // Defaults so the /chat background per-answer extraction never errors noisily.
  (intentRepo.savePartialIntent as jest.Mock).mockResolvedValue(undefined);
  (chatbot.extractIntent as jest.Mock).mockResolvedValue({ userProfileSummary: 'partial' });
  (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue(null);
  (runEnrichment as jest.Mock).mockResolvedValue(undefined);
});

describe('GET /onboarding/status', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/onboarding/status');
    expect(res.status).toBe(401);
  });

  it('returns the onboarding status', async () => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('completed');
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('completed');
  });
});

describe('GET /onboarding/known', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/onboarding/known');
    expect(res.status).toBe(401);
  });

  it('returns the inferred known profile', async () => {
    (known.inferKnownProfile as jest.Mock).mockResolvedValue({
      name: 'Stefan Avivson',
      firstName: 'Stefan',
      email: 'stefan@misterraw.com',
      country: 'Denmark',
      countryGuessed: true,
      company: 'Misterraw',
      companyGuessed: true,
    });
    const res = await request(app)
      .get('/onboarding/known')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Stefan');
    expect(res.body.data.company).toBe('Misterraw');
    expect(res.body.data.countryGuessed).toBe(true);
  });
});

describe('GET /onboarding/resume', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/onboarding/resume');
    expect(res.status).toBe(401);
  });

  it('returns the saved status and transcript', async () => {
    (intentRepo.getResume as jest.Mock).mockResolvedValue({
      status: 'in_progress',
      messages: [{ role: 'assistant', content: 'hi' }],
    });
    const res = await request(app)
      .get('/onboarding/resume')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.messages).toHaveLength(1);
  });
});

describe('POST /onboarding/chat', () => {
  const body = { messages: [{ role: 'user', content: 'I want to meet founders' }] };

  it('returns 503 LLM_DISABLED when no key is configured', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(false);
    const res = await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LLM_DISABLED');
    expect(chatbot.converse).not.toHaveBeenCalled();
  });

  it('returns the host reply and ready flag when enabled', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.converse as jest.Mock).mockResolvedValue({
      reply: 'What kind of founder?',
      ready: false,
    });
    const res = await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);
    expect(res.status).toBe(200);
    // Reply path is converse-only now; the live profile comes from /onboarding/profile.
    expect(res.body.data).toMatchObject({ reply: 'What kind of founder?', ready: false });
    expect(intentRepo.markInProgress).toHaveBeenCalledWith('user-abc');
  });

  it('rejects an empty messages array', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    const res = await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it('passes the confirmed profile through to converse', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
    const profile = { name: 'Stefan Avivson', country: 'Denmark', company: 'Mister Raw' };
    await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...body, profile });
    expect(chatbot.converse).toHaveBeenCalledTimes(1);
    const args = (chatbot.converse as jest.Mock).mock.calls[0];
    expect(args[1]).toMatchObject({ country: 'Denmark', company: 'Mister Raw' });
  });

  it('passes wrapMode=soft to converse on a soft finish', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
    await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...body, finish: true });
    expect((chatbot.converse as jest.Mock).mock.calls[0][2]).toBe('soft');
  });

  it('passes wrapMode=hard to converse on a hard finish', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: true });
    await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...body, hardFinish: true });
    expect((chatbot.converse as jest.Mock).mock.calls[0][2]).toBe('hard');
  });

  it('does NOT run extraction on /chat (decoupled to /profile for a fast reply)', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
    await request(app)
      .post('/onboarding/chat')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);
    await new Promise((r) => setImmediate(r));
    expect(chatbot.extractIntent).not.toHaveBeenCalled();
    expect(intentRepo.savePartialIntent).not.toHaveBeenCalled();
  });
});

describe('POST /onboarding/profile', () => {
  const profileBody = {
    messages: [
      { role: 'user', content: 'I want to meet founders' },
      { role: 'assistant', content: 'Got it.' },
    ],
  };

  it('returns 200 with a null profile when the LLM is disabled', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(false);
    const res = await request(app)
      .post('/onboarding/profile')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(profileBody);
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toBeNull();
    expect(chatbot.extractIntent).not.toHaveBeenCalled();
  });

  it('extracts the live profile and saves the running intent (no time cap)', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.extractIntent as jest.Mock).mockResolvedValue({ userRole: 'Founder' });
    (chatbot.liveProfileFromIntent as jest.Mock).mockReturnValue({ role: 'Founder', wantsToMeet: ['investors'], offers: [] });
    const res = await request(app)
      .post('/onboarding/profile')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(profileBody);
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toMatchObject({ role: 'Founder' });
    expect(chatbot.extractIntent).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(intentRepo.savePartialIntent).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty messages array', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    const res = await request(app)
      .post('/onboarding/profile')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /onboarding/confirm', () => {
  const body = {
    messages: [
      { role: 'user', content: 'I want to meet founders' },
      { role: 'assistant', content: "Here's what we heard." },
    ],
  };

  it('returns 503 when no key is configured', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(false);
    const res = await request(app)
      .post('/onboarding/confirm')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);
    expect(res.status).toBe(503);
    expect(chatbot.extractIntent).not.toHaveBeenCalled();
  });

  it('extracts intent, saves, and returns summary + profileComplete', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.extractIntent as jest.Mock).mockResolvedValue({
      userProfileSummary: 'A B2B founder and advisor.',
      profileStrength: 'strong',
    });
    (intentRepo.saveIntentAndComplete as jest.Mock).mockResolvedValue({ profileComplete: true });

    const res = await request(app)
      .post('/onboarding/confirm')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBe('A B2B founder and advisor.');
    expect(res.body.data.profileComplete).toBe(true);
    expect(intentRepo.saveIntentAndComplete).toHaveBeenCalledTimes(1);
  });

  it('passes the confirmed profile through to save', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    const intent = { userProfileSummary: 'x', profileStrength: 'strong' };
    (chatbot.extractIntent as jest.Mock).mockResolvedValue(intent);
    (intentRepo.saveIntentAndComplete as jest.Mock).mockResolvedValue({ profileComplete: false });
    const profile = { country: 'Denmark', company: 'Mister Raw' };
    await request(app)
      .post('/onboarding/confirm')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...body, profile });
    const args = (intentRepo.saveIntentAndComplete as jest.Mock).mock.calls[0];
    expect(args[0]).toBe('user-abc');
    expect(args[3]).toMatchObject({ country: 'Denmark', company: 'Mister Raw' });
  });
});

describe('POST /onboarding/enrich', () => {
  beforeEach(() => {
    (known.inferKnownProfile as jest.Mock).mockResolvedValue({
      name: 'Jane Doe', email: 'jane@acme.com', country: 'DE', company: 'Acme', linkedin: null,
    });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/onboarding/enrich').send({ linkedinUrl: 'jane-doe' });
    expect(res.status).toBe(401);
  });

  it('202s with status "searching" and fires runEnrichment without awaiting it', async () => {
    const res = await request(app)
      .post('/onboarding/enrich')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ linkedinUrl: 'jane-doe' });

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('searching');
    expect(runEnrichment).toHaveBeenCalledTimes(1);
    const [userId, input] = (runEnrichment as jest.Mock).mock.calls[0];
    expect(userId).toBe('user-abc');
    expect(input).toEqual({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe', fullName: 'Jane Doe' });
  });

  it('falls back to the known LinkedIn URL when none is supplied on this call', async () => {
    (known.inferKnownProfile as jest.Mock).mockResolvedValue({
      name: 'Jane Doe', linkedin: 'https://www.linkedin.com/in/jane-doe',
    });

    const res = await request(app)
      .post('/onboarding/enrich')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(202);
    const [, input] = (runEnrichment as jest.Mock).mock.calls[0];
    expect(input.linkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('200s with the cached status on a fresh 90-day cache hit (still fires the orchestrator to keep state in sync)', async () => {
    (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue({
      profile: { fullName: 'Jane Doe' },
      confidence: 0.95,
      sources: [],
      foundLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      requestedLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      enrichedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post('/onboarding/enrich')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ linkedinUrl: 'jane-doe' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('found');
    expect(runEnrichment).toHaveBeenCalledTimes(1);
  });

  it('202s (searching) when the cache is stale (>90 days)', async () => {
    (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue({
      profile: { fullName: 'Jane Doe' },
      confidence: 0.95,
      sources: [],
      foundLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      requestedLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      enrichedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const res = await request(app)
      .post('/onboarding/enrich')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ linkedinUrl: 'jane-doe' });

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('searching');
  });

  it('503s ENRICHMENT_DISABLED (and never fires runEnrichment) when the resolved provider is "none"', async () => {
    const original = (config as any).enrichProvider;
    (config as any).enrichProvider = 'none';
    try {
      const res = await request(app)
        .post('/onboarding/enrich')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ linkedinUrl: 'jane-doe' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ENRICHMENT_DISABLED');
      expect(runEnrichment).not.toHaveBeenCalled();
    } finally {
      (config as any).enrichProvider = original;
    }
  });

  it('rejects an over-length linkedinUrl (400) and never fires runEnrichment', async () => {
    const res = await request(app)
      .post('/onboarding/enrich')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ linkedinUrl: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(runEnrichment).not.toHaveBeenCalled();
  });
});

describe('POST /onboarding/admin/refresh-enrichment', () => {
  const uid = '11111111-1111-1111-1111-111111111111';

  it('rejects an unauthenticated request (401)', async () => {
    const res = await request(app).post('/onboarding/admin/refresh-enrichment').send({ userId: uid });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin member (403)', async () => {
    const res = await request(app)
      .post('/onboarding/admin/refresh-enrichment')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ userId: uid });
    expect(res.status).toBe(403);
  });
});
