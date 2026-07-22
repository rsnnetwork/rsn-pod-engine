import { IntentSchema, INTENT_JSON_SCHEMA } from '../../../services/onboarding/intent.schema';

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
  // C2: minimum structured profile additions
  userLanguages: ['English', 'French'],
  problemTheySolve: 'helps B2B teams shorten their sales cycle',
  authorityLevel: 'final decision maker',
  needsHelpWith: ['finding pilot customers'],
  meetingValueCriteria: 'a concrete intro to a warm pilot customer',
  restrictions: {
    noCompetitors: true,
    competitorNote: 'other sales coaching consultancies',
    geography: ['not remote only, must be EU based'],
    industriesToAvoid: ['recruiting'],
    seniorityToAvoid: ['junior'],
    requiredLanguages: ['English'],
  },
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

  it('rejects an invalid matchPriority value', () => {
    const result = IntentSchema.safeParse({ ...validIntent, matchPriority: 'urgent' });
    expect(result.success).toBe(false);
  });

  it('requires the Round B dimensions', () => {
    const { userValuableTo, ...missing } = validIntent;
    expect(IntentSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects a non-array desiredPeople', () => {
    const result = IntentSchema.safeParse({ ...validIntent, desiredPeople: 'founders' });
    expect(result.success).toBe(false);
  });

  describe('C2: minimum structured profile additions', () => {
    it('accepts a fixture with all C2 fields (languages, authority, meeting value, restrictions)', () => {
      const result = IntentSchema.safeParse(validIntent);
      expect(result.success).toBe(true);
    });

    it('accepts empty-safe defaults for the C2 additions (extractor found nothing, not guessing)', () => {
      const result = IntentSchema.safeParse({
        ...validIntent,
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
      });
      expect(result.success).toBe(true);
    });

    it('requires userLanguages', () => {
      const { userLanguages, ...missing } = validIntent;
      expect(IntentSchema.safeParse(missing).success).toBe(false);
    });

    it('requires restrictions', () => {
      const { restrictions, ...missing } = validIntent;
      expect(IntentSchema.safeParse(missing).success).toBe(false);
    });

    it('rejects restrictions.noCompetitors as a string instead of a boolean', () => {
      const result = IntentSchema.safeParse({
        ...validIntent,
        restrictions: { ...validIntent.restrictions, noCompetitors: 'yes' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects restrictions.geography as a non-array', () => {
      const result = IntentSchema.safeParse({
        ...validIntent,
        restrictions: { ...validIntent.restrictions, geography: 'EU only' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects restrictions.competitorNote as a number (must be string or null)', () => {
      const result = IntentSchema.safeParse({
        ...validIntent,
        restrictions: { ...validIntent.restrictions, competitorNote: 42 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-array needsHelpWith', () => {
      const result = IntentSchema.safeParse({ ...validIntent, needsHelpWith: 'pilot customers' });
      expect(result.success).toBe(false);
    });

    it('rejects a non-string authorityLevel', () => {
      const result = IntentSchema.safeParse({ ...validIntent, authorityLevel: 3 });
      expect(result.success).toBe(false);
    });
  });

  describe('INTENT_JSON_SCHEMA mirrors IntentSchema', () => {
    it('has exactly the same top-level required keys as the zod shape', () => {
      const zodKeys = Object.keys((IntentSchema as any).shape).sort();
      const jsonProps = Object.keys((INTENT_JSON_SCHEMA as any).properties).sort();
      const jsonRequired = [...(INTENT_JSON_SCHEMA as any).required].sort();
      expect(jsonProps).toEqual(zodKeys);
      expect(jsonRequired).toEqual(zodKeys);
    });

    it('models restrictions as a closed object with the same keys as zod', () => {
      const zodRestrictionsKeys = Object.keys(
        ((IntentSchema as any).shape.restrictions as any).shape
      ).sort();
      const jsonRestrictions = (INTENT_JSON_SCHEMA as any).properties.restrictions;
      expect(jsonRestrictions.type).toBe('object');
      expect(jsonRestrictions.additionalProperties).toBe(false);
      expect(Object.keys(jsonRestrictions.properties).sort()).toEqual(zodRestrictionsKeys);
      expect([...jsonRestrictions.required].sort()).toEqual(zodRestrictionsKeys);
    });

    it('models restrictions.competitorNote as a nullable string, matching zod .nullable()', () => {
      const jsonRestrictions = (INTENT_JSON_SCHEMA as any).properties.restrictions;
      expect(jsonRestrictions.properties.competitorNote).toEqual({ type: ['string', 'null'] });
    });

    it('models userLanguages, needsHelpWith, and restrictions arrays as string arrays', () => {
      const stringArray = { type: 'array', items: { type: 'string' } };
      expect((INTENT_JSON_SCHEMA as any).properties.userLanguages).toEqual(stringArray);
      expect((INTENT_JSON_SCHEMA as any).properties.needsHelpWith).toEqual(stringArray);
      const jsonRestrictions = (INTENT_JSON_SCHEMA as any).properties.restrictions;
      expect(jsonRestrictions.properties.geography).toEqual(stringArray);
      expect(jsonRestrictions.properties.industriesToAvoid).toEqual(stringArray);
      expect(jsonRestrictions.properties.seniorityToAvoid).toEqual(stringArray);
      expect(jsonRestrictions.properties.requiredLanguages).toEqual(stringArray);
    });
  });
});
