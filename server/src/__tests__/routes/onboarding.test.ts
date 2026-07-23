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
  hasSubstantiveProfileData: jest.fn(),
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
  getEnrichmentState: jest.fn(),
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

jest.mock('../../services/onboarding/stage-events.repo', () => ({
  record: jest.fn().mockResolvedValue(undefined),
  sanitizeErrorMessage: (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg
      .replace(/Bearer\s+\S+/gi, '[redacted]')
      .replace(/sk-[A-Za-z0-9_-]{10,}/gi, '[redacted]')
      .slice(0, 500);
  },
  __esModule: true,
}));

import { query as dbQuery } from '../../db';
import config from '../../config';
import onboardingRoutes from '../../routes/onboarding';
import { buildHostSystemPrompt } from '../../services/onboarding/prompts';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as chatbot from '../../services/onboarding/chatbot.service';
import * as intentRepo from '../../services/onboarding/intent.repo';
import * as known from '../../services/onboarding/known';
import * as enrichRepo from '../../services/onboarding/enrichment.repo';
import { runEnrichment } from '../../services/onboarding/enrichment.orchestrator';
import { record as recordStageEvent } from '../../services/onboarding/stage-events.repo';
import logger from '../../config/logger';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/onboarding', onboardingRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeToken(userId = 'user-abc', role = 'member') {
  return jwt.sign(
    { sub: userId, email: 'u@e.com', role, sessionId: 'sess-1' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

const app = createApp();

beforeEach(() => {
  jest.clearAllMocks();
  // authenticate's status check + any stray db call default to an active user.
  (dbQuery as jest.Mock).mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  (intentRepo.markInProgress as jest.Mock).mockResolvedValue(false);
  // Default: no on-file profile data (the pre-existing not_found mapping for
  // none/not_found/failed). Tests that want the Claus-rule partial branch
  // override this per-case.
  (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(false);
  (recordStageEvent as jest.Mock).mockResolvedValue(undefined);
  // Defaults so the /chat background per-answer extraction never errors noisily.
  (intentRepo.savePartialIntent as jest.Mock).mockResolvedValue(undefined);
  (chatbot.extractIntent as jest.Mock).mockResolvedValue({ userProfileSummary: 'partial' });
  (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue(null);
  (runEnrichment as jest.Mock).mockResolvedValue(undefined);
  (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
    status: 'none',
    source: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
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

  it('carries the enrichment block and preserves existing fields', async () => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('in_progress');
    (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
      status: 'found',
      source: 'linkedin-provider',
      error: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    });
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.enrichment).toEqual({
      status: 'found',
      error: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    });
    // provider identity is internal — never exposed on this member-facing payload
    expect(res.body.data.enrichment.source).toBeUndefined();
  });

  // The Claus rule: none/not_found/failed no longer collapse unconditionally to
  // not_found. When the member's saved columns already carry substantive data
  // (GET intentRepo.hasSubstantiveProfileData), the opening honors it instead
  // (opening='partial') so the chat never opens with "could not identify"
  // beside a card that already shows role/company/location. searching/found/
  // partial are untouched by this dimension.
  it.each([
    ['searching', false, 'searching'],
    ['searching', true, 'searching'],
    ['found', false, 'found'],
    ['found', true, 'found'],
    ['partial', false, 'partial'],
    ['partial', true, 'partial'],
    ['none', false, 'not_found'],
    ['none', true, 'partial'],
    ['not_found', false, 'not_found'],
    ['not_found', true, 'partial'],
    ['failed', false, 'not_found'],
    ['failed', true, 'partial'],
  ])('maps enrichment.status=%s (hasProfileData=%s) to opening=%s', async (enrichmentStatus, hasProfileData, expectedOpening) => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
    (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(hasProfileData);
    (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
      status: enrichmentStatus,
      source: null,
      error: enrichmentStatus === 'failed' ? 'provider timeout' : null,
      startedAt: null,
      completedAt: null,
    });
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.enrichment.status).toBe(enrichmentStatus);
    expect(res.body.data.opening).toBe(expectedOpening);
  });

  it('withholds the enrichment error from the member payload (admin-only via admin-inspect); opening still reads as not_found when no profile data is on file', async () => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
    (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(false);
    (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
      status: 'failed',
      source: null,
      error: 'provider timeout',
      startedAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    });
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    // Shape stability: the field exists, but the raw error never reaches a member.
    expect(res.body.data.enrichment).toHaveProperty('error', null);
    expect(res.body.data.opening).toBe('not_found');
  });

  it('a failed enrichment with substantive profile data already on file opens as partial, never not_found (the Claus rule)', async () => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
    (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(true);
    (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
      status: 'failed',
      source: null,
      error: 'provider timeout',
      startedAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:05.000Z',
    });
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.enrichment).toHaveProperty('error', null);
    expect(res.body.data.opening).toBe('partial');
  });

  describe('enrichment.candidate (the confirm-card prefill)', () => {
    const cachedResult = {
      profile: {
        fullName: 'Jane Doe',
        currentRole: 'CTO',
        currentCompany: 'Acme',
        industry: 'Software',
        location: 'Berlin',
        summary: 'Builds things.',
        likelyWantsToMeet: ['investors'],
        likelyOffers: ['engineering leadership'],
        linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      },
      confidence: 0.95,
      sources: [],
      foundLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      requestedLinkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      enrichedAt: new Date().toISOString(),
    };

    it.each(['found', 'partial'] as const)(
      'includes the cached enriched profile as enrichment.candidate when status=%s',
      async (status) => {
        (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
        (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
          status, source: 'scrapingdog', error: null, startedAt: null, completedAt: null,
        });
        (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue(cachedResult);
        const res = await request(app)
          .get('/onboarding/status')
          .set('Authorization', `Bearer ${makeToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.data.enrichment.candidate).toEqual(cachedResult.profile);
      },
    );

    it.each(['none', 'searching', 'not_found', 'failed'] as const)(
      'never includes candidate when status=%s, even when a cached blob exists',
      async (status) => {
        (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
        (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
          status, source: null, error: null, startedAt: null, completedAt: null,
        });
        (enrichRepo.getCachedEnrichment as jest.Mock).mockResolvedValue(cachedResult);
        const res = await request(app)
          .get('/onboarding/status')
          .set('Authorization', `Bearer ${makeToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.data.enrichment.candidate).toBeUndefined();
        // Not even looked up — the cache read only runs for found/partial.
        expect(enrichRepo.getCachedEnrichment).not.toHaveBeenCalled();
      },
    );

    it('omits candidate when found but the cache read fails or is empty (degrades, never 500s)', async () => {
      (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
      (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
        status: 'found', source: 'scrapingdog', error: null, startedAt: null, completedAt: null,
      });
      (enrichRepo.getCachedEnrichment as jest.Mock).mockRejectedValue(new Error('db down'));
      const res = await request(app)
        .get('/onboarding/status')
        .set('Authorization', `Bearer ${makeToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.enrichment.candidate).toBeUndefined();
      expect(res.body.data.opening).toBe('found');
    });
  });

  // Finding 4: a genuinely unrecognized status string still goes through
  // openingFromEnrichment's default branch, and that branch honors the Claus
  // rule exactly like the terminal-failure states, not a bespoke always-not_found rule.
  it.each([
    [false, 'not_found'],
    [true, 'partial'],
  ])('an unrecognized enrichment status (hasProfileData=%s) opens as %s (fail-safe + Claus rule)', async (hasProfileData, expectedOpening) => {
    (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
    (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(hasProfileData);
    (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
      status: 'unknown_status' as any,
      source: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
    const res = await request(app)
      .get('/onboarding/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.opening).toBe(expectedOpening);
  });

  // Finding 2: hasSubstantiveProfileData is a real DB query. openingFromEnrichment
  // only consults it for the none/not_found/failed/unrecognized branches — a
  // status of searching/found/partial ignores the flag entirely, so the route
  // must not pay for that query on every 2.5s client poll for those statuses.
  describe('hasSubstantiveProfileData short-circuit (only queried when the opening would use it)', () => {
    it.each(['searching', 'found', 'partial'] as const)(
      'does NOT query profile data when enrichment.status=%s (the opening ignores it)',
      async (status) => {
        (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
        (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
          status, source: null, error: null, startedAt: null, completedAt: null,
        });
        const res = await request(app)
          .get('/onboarding/status')
          .set('Authorization', `Bearer ${makeToken()}`);
        expect(res.status).toBe(200);
        expect(intentRepo.hasSubstantiveProfileData).not.toHaveBeenCalled();
      }
    );

    it.each(['none', 'not_found', 'failed', 'unknown_status'] as const)(
      'DOES query profile data when enrichment.status=%s (the opening depends on it)',
      async (status) => {
        (intentRepo.getOnboardingStatus as jest.Mock).mockResolvedValue('not_started');
        (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
          status: status as any, source: null, error: null, startedAt: null, completedAt: null,
        });
        const res = await request(app)
          .get('/onboarding/status')
          .set('Authorization', `Bearer ${makeToken()}`);
        expect(res.status).toBe(200);
        expect(intentRepo.hasSubstantiveProfileData).toHaveBeenCalledWith('user-abc');
      }
    );
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

  // ─── E1: chat_started fires ONLY on the user's first turn ─────────────────
  // markInProgress resolves true only when it actually performed the
  // not_started/update_required -> in_progress transition — the route must
  // key the stage event off THAT signal, not off every turn.
  // Each test uses its own userId (distinct rate-limit key) — onboardingChatLimiter
  // is a shared, process-wide budget (30/60s per user) across every test in this file.
  describe('E1: chat_started stage event', () => {
    it('fires when markInProgress reports a real transition (first turn)', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (intentRepo.markInProgress as jest.Mock).mockResolvedValue(true);

      await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken('user-e1-chat-1')}`)
        .send(body);
      await new Promise((r) => setImmediate(r));

      expect(recordStageEvent).toHaveBeenCalledWith('user-e1-chat-1', 'chat_started');
    });

    it('does NOT fire on a later turn (markInProgress reports no transition)', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (intentRepo.markInProgress as jest.Mock).mockResolvedValue(false);

      await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken('user-e1-chat-2')}`)
        .send(body);
      await new Promise((r) => setImmediate(r));

      expect(recordStageEvent).not.toHaveBeenCalledWith('user-e1-chat-2', 'chat_started');
    });

    it('does NOT fire when markInProgress rejects (best-effort, non-fatal)', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (intentRepo.markInProgress as jest.Mock).mockRejectedValue(new Error('db down'));

      const res = await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken('user-e1-chat-3')}`)
        .send(body);
      await new Promise((r) => setImmediate(r));

      expect(res.status).toBe(200);
      expect(recordStageEvent).not.toHaveBeenCalledWith('user-e1-chat-3', 'chat_started');
    });
  });

  // Finding 1 (the Claus rule reaching the chat): /chat used to pass the RAW
  // enrichment status straight into converse -> honestyClause. That let the
  // system prompt say "we could not retrieve their profile" in the exact same
  // turn where the client's second opening bubble (gated on the settled
  // 'partial' opening, which already honors on-file data) told the member we
  // had looked at their background — a direct contradiction inside one
  // conversation. Fixed: the route now resolves the SAME effective opening
  // GET /onboarding/status computes (openingFromEnrichment + the
  // hasSubstantiveProfileData short-circuit) and passes THAT to converse, so
  // the prompt, the status payload, and the client bubbles can never disagree.
  describe('honesty clause: the EFFECTIVE opening (not the raw status) reaches the host system prompt', () => {
    it.each([
      // status, hasProfileData, expected effective opening, expected clause
      ['found', false, 'found', 'what we already have for them'],
      ['partial', false, 'partial', 'what we already have for them'],
      ['not_found', false, 'not_found', 'we could not retrieve their profile'],
      ['none', false, 'not_found', 'we could not retrieve their profile'],
      ['failed', false, 'not_found', 'we could not retrieve their profile'],
      ['searching', false, 'searching', 'we could not retrieve their profile'],
      // found/partial ignore hasProfileData (unaffected by the Claus rule).
      ['found', true, 'found', 'what we already have for them'],
      ['partial', true, 'partial', 'what we already have for them'],
      ['searching', true, 'searching', 'we could not retrieve their profile'],
      // The Claus rule itself reaching the chat: a terminal-failure status
      // with substantive on-file data effectively opens 'partial', so the
      // clause must switch to the "what we already have" branch too.
      ['none', true, 'partial', 'what we already have for them'],
      ['not_found', true, 'partial', 'what we already have for them'],
      ['failed', true, 'partial', 'what we already have for them'],
    ] as const)(
      'status=%s, hasProfileData=%s -> effective opening=%s -> converse receives the "%s" honesty clause',
      async (status, hasProfileData, expectedOpening, expectedClause) => {
        // Distinct userId per row (distinct rate-limit key) — onboardingChatLimiter
        // is a shared, process-wide budget (30/60s per user) across every test in
        // this file, same discipline as the E1 block above.
        const userId = `user-honesty-${status}-${hasProfileData}`;
        (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
        (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
        (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(hasProfileData);
        (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
          status,
          source: null,
          error: null,
          startedAt: null,
          completedAt: null,
        });

        await request(app)
          .post('/onboarding/chat')
          .set('Authorization', `Bearer ${makeToken(userId)}`)
          .send(body);

        expect(chatbot.converse).toHaveBeenCalledTimes(1);
        const args = (chatbot.converse as jest.Mock).mock.calls[0];
        // converse receives the EFFECTIVE opening, never the raw status.
        expect(args[4]).toBe(expectedOpening);
        // Finding 2 (kept consistent here): the profile-data query only runs
        // for the branches whose opening actually depends on it.
        const needsLookup = status === 'none' || status === 'not_found' || status === 'failed';
        if (needsLookup) {
          expect(intentRepo.hasSubstantiveProfileData).toHaveBeenCalledWith(userId);
        } else {
          expect(intentRepo.hasSubstantiveProfileData).not.toHaveBeenCalled();
        }
        // Feed the same args converse received into the real (unmocked) prompt
        // builder — proves the state the route passed actually resolves to the
        // right, and only the right, honesty clause.
        const prompt = buildHostSystemPrompt(args[1], args[2], args[3], args[4]).toLowerCase();
        expect(prompt).toContain(expectedClause);
      }
    );

    // The exact scenario from the review finding, spelled out explicitly
    // rather than folded into the table above.
    it('failed status + substantive on-file company data: converse receives the partial-side (what we already have) clause', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(true);
      (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
        status: 'failed', source: null, error: 'provider timeout', startedAt: null, completedAt: null,
      });

      await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken('user-honesty-explicit-1')}`)
        .send(body);

      const args = (chatbot.converse as jest.Mock).mock.calls[0];
      expect(args[4]).toBe('partial');
      const prompt = buildHostSystemPrompt(args[1], args[2], args[3], args[4]).toLowerCase();
      expect(prompt).toContain('what we already have for them');
      expect(prompt).not.toContain('we could not retrieve their profile');
    });

    it('failed status + a blank profile (nothing on file): converse receives the not-retrieved clause', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (intentRepo.hasSubstantiveProfileData as jest.Mock).mockResolvedValue(false);
      (enrichRepo.getEnrichmentState as jest.Mock).mockResolvedValue({
        status: 'failed', source: null, error: 'provider timeout', startedAt: null, completedAt: null,
      });

      await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken('user-honesty-explicit-2')}`)
        .send(body);

      const args = (chatbot.converse as jest.Mock).mock.calls[0];
      expect(args[4]).toBe('not_found');
      const prompt = buildHostSystemPrompt(args[1], args[2], args[3], args[4]).toLowerCase();
      expect(prompt).toContain('we could not retrieve their profile');
      expect(prompt).not.toContain('what we already have for them');
    });

    it('a failed enrichment lookup degrades to the not-retrieved clause rather than 500ing the chat', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.converse as jest.Mock).mockResolvedValue({ reply: 'ok', ready: false });
      (enrichRepo.getEnrichmentState as jest.Mock).mockRejectedValue(new Error('db down'));

      const res = await request(app)
        .post('/onboarding/chat')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send(body);

      expect(res.status).toBe(200);
      const args = (chatbot.converse as jest.Mock).mock.calls[0];
      const prompt = buildHostSystemPrompt(args[1], args[2], args[3], args[4]).toLowerCase();
      expect(prompt).toContain('we could not retrieve their profile');
    });
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

  // E1: extractIntent throwing here is swallowed (200, profile:null) but is
  // still an extraction failure the admin inspector needs visibility into.
  it('E1: records extract_failed (sanitized message, source=profile) when extraction throws, still returns 200 with a null profile', async () => {
    (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
    (chatbot.extractIntent as jest.Mock).mockRejectedValue(new Error('anthropic 500: sk-ant-verysecretkey1234567890'));

    const res = await request(app)
      .post('/onboarding/profile')
      .set('Authorization', `Bearer ${makeToken('user-e1-profile-1')}`)
      .send(profileBody);

    expect(res.status).toBe(200);
    expect(res.body.data.profile).toBeNull();
    expect(recordStageEvent).toHaveBeenCalledWith(
      'user-e1-profile-1',
      'extract_failed',
      expect.objectContaining({ message: expect.any(String), source: 'profile' }),
    );
    const [, , detail] = (recordStageEvent as jest.Mock).mock.calls.find((c) => c[1] === 'extract_failed')!;
    expect(detail.message).not.toContain('sk-ant-verysecretkey1234567890');
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

  // ─── E1: confirmed stage event ──────────────────────────────────────────
  // Each test uses its own userId (distinct rate-limit key) — see the
  // chat_started describe block above for why.
  describe('E1: confirmed stage event', () => {
    it('records confirmed with profileStrength on success', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.extractIntent as jest.Mock).mockResolvedValue({
        userProfileSummary: 'A B2B founder.',
        profileStrength: 'strong',
      });
      (intentRepo.saveIntentAndComplete as jest.Mock).mockResolvedValue({ profileComplete: true });

      const res = await request(app)
        .post('/onboarding/confirm')
        .set('Authorization', `Bearer ${makeToken('user-e1-confirm-1')}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(recordStageEvent).toHaveBeenCalledWith('user-e1-confirm-1', 'confirmed', { profileStrength: 'strong' });
    });

    it('records confirmed with an empty detail when profileStrength is not present', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.extractIntent as jest.Mock).mockResolvedValue({ userProfileSummary: 'A B2B founder.' });
      (intentRepo.saveIntentAndComplete as jest.Mock).mockResolvedValue({ profileComplete: true });

      await request(app)
        .post('/onboarding/confirm')
        .set('Authorization', `Bearer ${makeToken('user-e1-confirm-2')}`)
        .send(body);

      expect(recordStageEvent).toHaveBeenCalledWith('user-e1-confirm-2', 'confirmed', {});
    });
  });

  // ─── E1: extract_failed stage event (LLM_DISABLED fallback path) ────────
  describe('E1: extract_failed stage event', () => {
    it('records extract_failed with a sanitized error message and source=confirm when extraction throws', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(true);
      (chatbot.extractIntent as jest.Mock).mockRejectedValue(new Error('anthropic 500: Bearer sk-ant-verysecretkey1234567890'));

      const res = await request(app)
        .post('/onboarding/confirm')
        .set('Authorization', `Bearer ${makeToken('user-e1-confirm-3')}`)
        .send(body);

      expect(res.status).toBe(503);
      expect(recordStageEvent).toHaveBeenCalledWith(
        'user-e1-confirm-3',
        'extract_failed',
        expect.objectContaining({ message: expect.any(String), source: 'confirm' }),
      );
      const [, , detail] = (recordStageEvent as jest.Mock).mock.calls.find((c) => c[1] === 'extract_failed')!;
      expect(detail.message).not.toContain('sk-ant-verysecretkey1234567890');
      expect(detail.message).not.toContain('Bearer');
    });

    it('does not record extract_failed on the LLM_DISABLED (isEnabled=false) path — that is not an extraction failure', async () => {
      (chatbot.isEnabled as jest.Mock).mockReturnValue(false);

      await request(app)
        .post('/onboarding/confirm')
        .set('Authorization', `Bearer ${makeToken('user-e1-confirm-4')}`)
        .send(body);

      expect(recordStageEvent).not.toHaveBeenCalledWith(
        'user-e1-confirm-4',
        'extract_failed',
        expect.anything(),
      );
    });
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
    expect(res.body.data.status).toBe('searching');
    expect(runEnrichment).toHaveBeenCalledTimes(1);
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
    expect(runEnrichment).toHaveBeenCalledTimes(1);
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

  // ─── E3 correction: this endpoint re-runs enrichment for the TARGET member
  // (not the calling admin) — clearEnrichment(userId) then fire-and-forget
  // runEnrichment(userId, { linkedinUrl, fullName }) sourced from the target's
  // own users row, finally giving the previously-orphaned POST /onboarding/enrich
  // machinery a caller path via the orchestrator directly.
  describe('E3: fires runEnrichment for the target user and returns 202', () => {
    function mockUsersRow(row: { linkedin_url: string | null; display_name: string | null } | null) {
      (dbQuery as jest.Mock).mockImplementation((sql: string) => {
        if (/SELECT\s+status\s+FROM\s+users/i.test(sql)) {
          return Promise.resolve({ rows: [{ status: 'active' }], rowCount: 1 });
        }
        if (/SELECT\s+linkedin_url,\s*display_name\s+FROM\s+users\s+WHERE\s+id\s*=\s*\$1/i.test(sql.trim())) {
          return Promise.resolve(row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    }

    it('clears enrichment, fires runEnrichment with the target linkedin url + display name, 202s', async () => {
      mockUsersRow({ linkedin_url: 'https://www.linkedin.com/in/jane-doe', display_name: 'Jane Doe' });

      const res = await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('admin-1', 'admin')}`)
        .send({ userId: uid });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cleared).toBe(true);

      expect(enrichRepo.clearEnrichment).toHaveBeenCalledWith(uid);

      expect(runEnrichment).toHaveBeenCalledTimes(1);
      const [calledUserId, input] = (runEnrichment as jest.Mock).mock.calls[0];
      expect(calledUserId).toBe(uid);
      expect(input).toEqual({ linkedinUrl: 'https://www.linkedin.com/in/jane-doe', fullName: 'Jane Doe' });
    });

    it('clears BEFORE firing runEnrichment (ordering matters — the run must see the cleared state)', async () => {
      mockUsersRow({ linkedin_url: null, display_name: 'Jane Doe' });
      const order: string[] = [];
      (enrichRepo.clearEnrichment as jest.Mock).mockImplementation(async () => {
        order.push('clear');
      });
      (runEnrichment as jest.Mock).mockImplementation(async () => {
        order.push('run');
      });

      await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('admin-1', 'admin')}`)
        .send({ userId: uid });

      expect(order).toEqual(['clear', 'run']);
    });

    it('passes a null linkedinUrl and undefined fullName when the target has neither set', async () => {
      mockUsersRow({ linkedin_url: null, display_name: null });

      const res = await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('admin-1', 'admin')}`)
        .send({ userId: uid });

      expect(res.status).toBe(202);
      const [, input] = (runEnrichment as jest.Mock).mock.calls[0];
      expect(input).toEqual({ linkedinUrl: null, fullName: undefined });
    });

    it('a super_admin also passes (role hierarchy)', async () => {
      mockUsersRow({ linkedin_url: null, display_name: null });
      const res = await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('super-1', 'super_admin')}`)
        .send({ userId: uid });
      expect(res.status).toBe(202);
    });

    it('does not fail the request when runEnrichment rejects (fire-and-forget, logged, never awaited)', async () => {
      mockUsersRow({ linkedin_url: null, display_name: 'Jane Doe' });
      (runEnrichment as jest.Mock).mockRejectedValue(new Error('boom'));

      const res = await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('admin-1', 'admin')}`)
        .send({ userId: uid });

      expect(res.status).toBe(202);
      await new Promise((r) => setImmediate(r));
      expect(logger.error).toHaveBeenCalled();
    });

    it('rejects a missing userId (400) and never touches clearEnrichment/runEnrichment', async () => {
      const res = await request(app)
        .post('/onboarding/admin/refresh-enrichment')
        .set('Authorization', `Bearer ${makeToken('admin-1', 'admin')}`)
        .send({});
      expect(res.status).toBe(400);
      expect(enrichRepo.clearEnrichment).not.toHaveBeenCalled();
      expect(runEnrichment).not.toHaveBeenCalled();
    });
  });
});
