import { IntentSchema } from '../../../services/onboarding/intent.schema';

const validIntent = {
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
  avoidPreferences: ['recruiters'],
  privacyRecommendation: 'normal',
  matchingTags: ['b2b', 'sales', 'founder'],
  embeddingText: 'A B2B sales advisor who wants to meet revenue-stage founders.',
  confidenceScores: { desiredPeople: 0.9, reasonForMeeting: 0.8, userProfile: 0.85 },
  profileStrength: 'strong',
};

describe('IntentSchema', () => {
  it('accepts a fully-formed extraction object', () => {
    const result = IntentSchema.safeParse(validIntent);
    expect(result.success).toBe(true);
  });

  it('accepts null for optional userCompany / userIndustry / userLocation', () => {
    const result = IntentSchema.safeParse({
      ...validIntent,
      userCompany: null,
      userIndustry: null,
      userLocation: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const { reasonForMeeting, ...missing } = validIntent;
    const result = IntentSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid profileStrength value', () => {
    const result = IntentSchema.safeParse({ ...validIntent, profileStrength: 'medium' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array desiredPeople', () => {
    const result = IntentSchema.safeParse({ ...validIntent, desiredPeople: 'founders' });
    expect(result.success).toBe(false);
  });
});
