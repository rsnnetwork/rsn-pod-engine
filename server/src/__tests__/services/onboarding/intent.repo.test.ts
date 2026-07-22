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
}));

const mockNotifyMatchesOfNewUser = jest.fn<any>();
jest.mock('../../../services/matching/platform-match.service', () => ({
  notifyMatchesOfNewUser: (...args: unknown[]) => mockNotifyMatchesOfNewUser(...args),
}));

import { saveIntentAndComplete } from '../../../services/onboarding/intent.repo';
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
