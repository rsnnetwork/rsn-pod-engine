// ─── Onboarding Intent Schema (extraction call) ──────────────────────────────
//
// Zod schema for Claude's structured-output extraction call. Lives server-side
// (the shared package has no zod dependency) and mirrors the OnboardingIntent
// type in @rsn/shared. Used with `messages.parse` + `zodOutputFormat` so the
// model's JSON is validated against this shape before we ever touch it.
//
// Structured-output JSON-schema rules we obey here: no min/max/length
// constraints, every object closed (no open records — confidenceScores is a
// fixed shape), and optional fields modelled as `.nullable()` (all keys are
// always present in the output).

import { z } from 'zod';

export const IntentSchema = z.object({
  // Who they want to meet
  desiredPeople: z.array(z.string()),
  desiredRoles: z.array(z.string()),
  desiredSeniority: z.array(z.string()),
  desiredStage: z.array(z.string()),
  desiredIndustries: z.array(z.string()),
  // Why
  reasonForMeeting: z.string(),
  desiredOutcome: z.string(),
  // Who the user is
  userProfileSummary: z.string(),
  userRole: z.string(),
  userCompany: z.string().nullable(),
  userIndustry: z.string().nullable(),
  userLocation: z.string().nullable(),
  userExpertise: z.array(z.string()),
  userCanOffer: z.array(z.string()),
  userInterests: z.array(z.string()),
  userCity: z.string().nullable(),
  // Round B: richer matching dimensions
  userValuableTo: z.array(z.string()),
  suggestedInvitees: z.array(z.string()),
  currentFocus: z.string(),
  matchPriority: z.enum(['high', 'medium', 'low']),
  // Phase 2: structured designation categories (cleaner than free-text role).
  userDesignation: z.string(),
  desiredDesignations: z.array(z.string()),
  avoidDesignations: z.array(z.string()),
  // Guardrails + matching signals
  avoidPreferences: z.array(z.string()),
  privacyRecommendation: z.string(),
  matchingTags: z.array(z.string()),
  embeddingText: z.string(),
  confidenceScores: z.object({
    desiredPeople: z.number(),
    reasonForMeeting: z.number(),
    userProfile: z.number(),
  }),
  profileStrength: z.enum(['strong', 'weak']),
  // C2: minimum structured profile additions. All empty-safe (see EXTRACTION_PROMPT):
  // the extractor returns [] / '' / false / null rather than guessing.
  userLanguages: z.array(z.string()),
  problemTheySolve: z.string(),
  authorityLevel: z.string(),
  needsHelpWith: z.array(z.string()),
  meetingValueCriteria: z.string(),
  restrictions: z.object({
    noCompetitors: z.boolean(),
    competitorNote: z.string().nullable(),
    geography: z.array(z.string()),
    industriesToAvoid: z.array(z.string()),
    seniorityToAvoid: z.array(z.string()),
    requiredLanguages: z.array(z.string()),
  }),
});

export type ExtractedIntent = z.infer<typeof IntentSchema>;

// Raw JSON Schema for the structured-output extraction call. We pass this to
// `messages.create({ output_config: { format: { type: 'json_schema', schema } } })`
// and validate the model's reply against IntentSchema (zod) afterwards. We hand-
// author the JSON Schema rather than derive it from zod because the SDK's
// zodOutputFormat helper targets zod v4 and this project is pinned to zod v3.
// Structured-output rules: every object closed (additionalProperties:false),
// every key required, optional fields modelled as a ["string","null"] union.
const stringArray = { type: 'array', items: { type: 'string' } } as const;

export const INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'desiredPeople', 'desiredRoles', 'desiredSeniority', 'desiredStage', 'desiredIndustries',
    'reasonForMeeting', 'desiredOutcome', 'userProfileSummary', 'userRole', 'userCompany',
    'userIndustry', 'userLocation', 'userExpertise', 'userCanOffer', 'userInterests',
    'userCity', 'userValuableTo', 'suggestedInvitees', 'currentFocus', 'matchPriority',
    'userDesignation', 'desiredDesignations', 'avoidDesignations',
    'avoidPreferences', 'privacyRecommendation', 'matchingTags', 'embeddingText',
    'confidenceScores', 'profileStrength',
    'userLanguages', 'problemTheySolve', 'authorityLevel', 'needsHelpWith',
    'meetingValueCriteria', 'restrictions',
  ],
  properties: {
    desiredPeople: stringArray,
    desiredRoles: stringArray,
    desiredSeniority: stringArray,
    desiredStage: stringArray,
    desiredIndustries: stringArray,
    reasonForMeeting: { type: 'string' },
    desiredOutcome: { type: 'string' },
    userProfileSummary: { type: 'string' },
    userRole: { type: 'string' },
    userCompany: { type: ['string', 'null'] },
    userIndustry: { type: ['string', 'null'] },
    userLocation: { type: ['string', 'null'] },
    userExpertise: stringArray,
    userCanOffer: stringArray,
    userInterests: stringArray,
    userCity: { type: ['string', 'null'] },
    userValuableTo: stringArray,
    suggestedInvitees: stringArray,
    currentFocus: { type: 'string' },
    matchPriority: { type: 'string', enum: ['high', 'medium', 'low'] },
    userDesignation: { type: 'string' },
    desiredDesignations: stringArray,
    avoidDesignations: stringArray,
    avoidPreferences: stringArray,
    privacyRecommendation: { type: 'string' },
    matchingTags: stringArray,
    embeddingText: { type: 'string' },
    confidenceScores: {
      type: 'object',
      additionalProperties: false,
      required: ['desiredPeople', 'reasonForMeeting', 'userProfile'],
      properties: {
        desiredPeople: { type: 'number' },
        reasonForMeeting: { type: 'number' },
        userProfile: { type: 'number' },
      },
    },
    profileStrength: { type: 'string', enum: ['strong', 'weak'] },
    userLanguages: stringArray,
    problemTheySolve: { type: 'string' },
    authorityLevel: { type: 'string' },
    needsHelpWith: stringArray,
    meetingValueCriteria: { type: 'string' },
    restrictions: {
      type: 'object',
      additionalProperties: false,
      required: [
        'noCompetitors', 'competitorNote', 'geography',
        'industriesToAvoid', 'seniorityToAvoid', 'requiredLanguages',
      ],
      properties: {
        noCompetitors: { type: 'boolean' },
        competitorNote: { type: ['string', 'null'] },
        geography: stringArray,
        industriesToAvoid: stringArray,
        seniorityToAvoid: stringArray,
        requiredLanguages: stringArray,
      },
    },
  },
};
