// ─── intent.repo saveIntentAndComplete: users-column promotion ──────────────
// Covers the ONE new users-column promotion added for C2: userLanguages ->
// users.languages (text[], existing since migration 001). Everything else in
// the extracted intent rides along automatically inside the matching_intent
// JSONB blob (see the INSERT INTO user_intent_profiles call), which is not
// re-asserted field-by-field here since it's a single JSON.stringify(intent).

import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
const mockTransaction = jest.fn<any>();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetCachedEnrichment = jest.fn<any>();
jest.mock('../../../services/onboarding/enrichment.repo', () => ({
  getCachedEnrichment: (...args: unknown[]) => mockGetCachedEnrichment(...args),
  // Pure comparison; the real one lives in enrichment.repo (B1, 3 Sep 2026).
  sameTitle: (a: unknown, b: unknown) => {
    const n = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    return n(a).length > 0 && n(a) === n(b);
  },
}));

const mockNotifyMatchesOfNewUser = jest.fn<any>();
jest.mock('../../../services/matching/platform-match.service', () => ({
  notifyMatchesOfNewUser: (...args: unknown[]) => mockNotifyMatchesOfNewUser(...args),
}));

import { saveIntentAndComplete, markInProgress, savePartialIntent, saveTranscriptOnly } from '../../../services/onboarding/intent.repo';
import { ExtractedIntent } from '../../../services/onboarding/intent.schema';

const baseIntent: ExtractedIntent = {
  desiredPeople: ['B2B founders'],
  desiredRoles: ['founder'],
  desiredSeniority: ['senior'],
  desiredStage: ['revenue'],
  desiredIndustries: ['saas'],
  reasonForMeeting: 'help them see why customers buy',
  desiredOutcome: 'advisory relationships',
  userProfileSummary: 'A B2B sales advisor and founder.',
  userRole: 'founder & advisor',
  userCompany: 'Acme',
  userIndustry: 'b2b sales',
  userLocation: null,
  userExpertise: ['sales'],
  userCanOffer: ['sales coaching'],
  userInterests: ['startups'],
  userCity: null,
  userValuableTo: ['early-stage founders'],
  suggestedInvitees: [],
  currentFocus: 'scaling sales',
  matchPriority: 'high',
  userDesignation: 'founder',
  desiredDesignations: ['investor'],
  avoidDesignations: [],
  avoidPreferences: ['recruiters'],
  privacyRecommendation: 'normal',
  matchingTags: ['b2b', 'sales', 'founder'],
  embeddingText: 'A B2B sales advisor who wants to meet revenue-stage founders.',
  confidenceScores: { desiredPeople: 0.9, reasonForMeeting: 0.8, userProfile: 0.85 },
  profileStrength: 'strong',
  userLanguages: [],
  problemTheySolve: '',
  authorityLevel: '',
  needsHelpWith: [],
  meetingValueCriteria: '',
  restrictions: {
    noCompetitors: false,
    competitorNote: null,
    geography: [],
    industriesToAvoid: [],
    seniorityToAvoid: [],
    requiredLanguages: [],
  },
};

/** Build a fake transaction client that answers each SELECT/UPDATE saveIntentAndComplete issues. */
function makeFakeClient() {
  const calls: { sql: string; params: any[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      if (/SELECT display_name, first_name, last_name FROM users/i.test(sql)) {
        return { rows: [{ display_name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe' }] };
      }
      if (/SELECT first_name, last_name, display_name, company, job_title, industry, reasons_to_connect/i.test(sql)) {
        return {
          rows: [{
            first_name: 'Jane', last_name: 'Doe', display_name: 'Jane Doe',
            company: 'Acme', job_title: 'Founder', industry: 'saas',
            reasons_to_connect: ['b2b'],
          }],
        };
      }
      return { rows: [] };
    }),
  };
  return { client, calls };
}

function updateUsersCall(calls: { sql: string; params: any[] }[]) {
  return calls.find((c) => /UPDATE users SET/i.test(c.sql) && /company = COALESCE/i.test(c.sql));
}

describe('saveIntentAndComplete: userLanguages -> users.languages promotion', () => {
  beforeEach(() => {
    mockGetCachedEnrichment.mockResolvedValue(null);
    mockNotifyMatchesOfNewUser.mockResolvedValue(0);
  });

  it('promotes a non-empty userLanguages to the users.languages column', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));

    await saveIntentAndComplete('user-1', { ...baseIntent, userLanguages: ['English', 'French'] }, []);

    const update = updateUsersCall(calls);
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/languages\s*=/i);
    expect(update!.params).toEqual(expect.arrayContaining([['English', 'French']]));
  });

  it('trims and de-duplicates exact-match userLanguages before promoting', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));

    await saveIntentAndComplete('user-1', { ...baseIntent, userLanguages: [' English ', 'English', 'French'] }, []);

    const update = updateUsersCall(calls);
    expect(update!.params).toEqual(expect.arrayContaining([['English', 'French']]));
  });

  it('does not clobber the existing users.languages when userLanguages is empty (extractor found nothing)', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));

    await saveIntentAndComplete('user-1', { ...baseIntent, userLanguages: [] }, []);

    const update = updateUsersCall(calls);
    expect(update).toBeDefined();
    // null so COALESCE($n, languages) preserves whatever the column already has,
    // matching how company/industry/etc are handled when nothing new came through.
    expect(update!.params).toEqual(expect.arrayContaining([null]));
    expect(update!.sql).toMatch(/languages\s*=\s*COALESCE/i);
  });
});

// ─── 3 Sep 2026: professional_role is who the member IS, never who they asked for ──
// Stefan answered "I need a developer"; the extractor set userRole="developer";
// this column was written from it unconditionally, and Stefan surfaced in every
// Developers agent. Four members who said nothing had their roles wiped to [].
describe('saveIntentAndComplete: professional_role comes from who the member is', () => {
  beforeEach(() => {
    mockGetCachedEnrichment.mockResolvedValue(null);
    mockNotifyMatchesOfNewUser.mockResolvedValue(0);
  });
  const rolesParam = (calls: { sql: string; params: any[] }[]) => updateUsersCall(calls)!.params[4];

  it("Stefan's case: the role he asked for is dropped; the card role and his own designation stay", async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));
    await saveIntentAndComplete('stefan', {
      ...baseIntent, userRole: 'developer', userDesignation: 'founder',
      desiredRoles: ['developer'], desiredPeople: ['web developer'],
    }, [], { role: 'CEO', company: 'Raw Speed Networking | RSN' } as any);
    expect(rolesParam(calls)).toEqual(['CEO', 'Founder']);
  });

  it('a role the member gave for themselves is kept even when it is a designation', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));
    await saveIntentAndComplete('lorin', {
      ...baseIntent, userRole: 'operations consultant', userDesignation: 'consultant',
      desiredRoles: ['founder'], desiredPeople: ['tech founders scaling delivery operations'],
    }, [], { role: 'Owner' } as any);
    expect(rolesParam(calls)).toEqual(['Owner', 'Consultant']);
  });

  it('a founder looking for founders keeps Founder because the card confirmed it', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));
    await saveIntentAndComplete('cofounder', {
      ...baseIntent, userRole: 'founder', userDesignation: 'founder',
      desiredRoles: ['founder'], desiredPeople: ['a technical co-founder'],
    }, [], { role: 'Founder' } as any);
    expect(rolesParam(calls)).toEqual(['Founder']);
  });

  it('silence about oneself no longer wipes the column: null → COALESCE keeps what was there', async () => {
    const { client, calls } = makeFakeClient();
    mockTransaction.mockImplementation(async (cb: any) => cb(client));
    await saveIntentAndComplete('quiet', {
      ...baseIntent, userRole: '', userDesignation: '', desiredRoles: ['investor'], desiredPeople: ['angels'],
    }, [], undefined);
    expect(rolesParam(calls)).toBeNull();
    expect(updateUsersCall(calls)!.sql).toMatch(/professional_role\s*=\s*COALESCE\(\$5, professional_role\)/);
  });
});

// ─── update_required must be treated like not_started (loop-trap closure) ──
// D3's backfill sets existing users to 'update_required'. Every guard that
// currently re-arms/advances a fresh ('not_started') user must do the same
// for 'update_required', or those users get stuck forever.

describe('markInProgress: accepts update_required as a starting state', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('issues an UPDATE whose WHERE clause accepts both not_started and update_required', async () => {
    await markInProgress('user-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/onboarding_status\s*=\s*'in_progress'/i);
    expect(sql).toMatch(/'not_started'/);
    expect(sql).toMatch(/'update_required'/);
    expect(params).toEqual(['user-1']);
  });

  // E1: the route needs to know whether THIS call actually performed the
  // not_started/update_required -> in_progress transition, so it can emit a
  // chat_started stage event on the user's first turn only, not every turn.
  it('E1: resolves true when the UPDATE actually matched a row (a real transition)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(markInProgress('user-1')).resolves.toBe(true);
  });

  it('E1: resolves false when the WHERE clause matched nothing (already in_progress/completed)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(markInProgress('user-1')).resolves.toBe(false);
  });
});

describe('savePartialIntent: re-arms from update_required', () => {
  const intent = { ...baseIntent };

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('does not bail out early when the current status is update_required', async () => {
    // 1st call: guard SELECT onboarding_status -> 'update_required' (not 'completed',
    // so the save must proceed, not return early).
    mockQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_status: 'update_required' }] })
      .mockResolvedValueOnce({ rows: [] }) // upsert into user_intent_profiles
      .mockResolvedValueOnce({ rows: [] }); // UPDATE users SET onboarding_status = 'in_progress' ...

    await savePartialIntent('user-1', intent, []);

    // The upsert AND the re-arm UPDATE both ran — proves the guard didn't return early.
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('re-arms onboarding_status to in_progress from update_required (not just not_started)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_status: 'update_required' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await savePartialIntent('user-1', intent, []);

    const rearmCall = mockQuery.mock.calls.find((c: any[]) => /UPDATE users SET onboarding_status = 'in_progress'/i.test(c[0]));
    expect(rearmCall).toBeDefined();
    expect(rearmCall![0]).toMatch(/'not_started'/);
    expect(rearmCall![0]).toMatch(/'update_required'/);
  });

  it('still bails out early when the current status is completed (does not clobber a finished profile)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ onboarding_status: 'completed' }] });

    await savePartialIntent('user-1', intent, []);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// The transcript must survive an extraction failure — when every extraction
// 400'd in prod, conversations were lost because the only save path required
// an intent. saveTranscriptOnly upserts just the conversation.
describe('saveTranscriptOnly', () => {
  const conversation = [
    { role: 'user' as const, content: 'I build software' },
    { role: 'assistant' as const, content: 'Great — for whom?' },
  ];

  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('upserts the conversation without touching intent columns', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ onboarding_status: 'in_progress' }] })
      .mockResolvedValueOnce({ rows: [] }); // upsert

    await saveTranscriptOnly('user-1', conversation);

    const upsert = mockQuery.mock.calls.find((c: any[]) => /INSERT INTO user_intent_profiles/i.test(c[0]));
    expect(upsert).toBeDefined();
    expect(upsert![0]).toMatch(/onboarding_conversation/);
    expect(upsert![0]).not.toMatch(/matching_intent\s*=\s*EXCLUDED/i);
    expect(upsert![1]).toEqual(['user-1', JSON.stringify(conversation)]);
  });

  it('bails out when the profile is already completed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ onboarding_status: 'completed' }] });

    await saveTranscriptOnly('user-1', conversation);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
