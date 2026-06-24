// Mock the Anthropic SDK before importing the service. extractIntent now uses
// messages.create with a raw JSON-schema output_config and validates the reply
// with zod, so the SDK surface we need is just messages.create.
const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

jest.mock('../../../config', () => ({
  __esModule: true,
  default: {
    anthropicApiKey: 'test-key',
    onboardingChatModel: 'claude-haiku-4-5',
    onboardingExtractModel: 'claude-haiku-4-5',
  },
}));

import { converse, extractIntent, isEnabled } from '../../../services/onboarding/chatbot.service';
import { READY_TOKEN } from '../../../services/onboarding/prompts';

const history = [{ role: 'user' as const, content: 'I want to meet founders' }];

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
};

describe('chatbot.service', () => {
  describe('isEnabled', () => {
    it('is true when a key is configured', () => {
      expect(isEnabled()).toBe(true);
    });
  });

  describe('converse', () => {
    it('returns the reply and ready=false for a normal turn', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'What kind of founder?' }],
      });
      const { reply, ready } = await converse(history);
      expect(reply).toBe('What kind of founder?');
      expect(ready).toBe(false);
    });

    it('detects the READY token, strips it, and sets ready=true', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: `Here's what we heard.\n${READY_TOKEN}` }],
      });
      const { reply, ready } = await converse(history);
      expect(ready).toBe(true);
      expect(reply).toBe("Here's what we heard.");
      expect(reply).not.toContain(READY_TOKEN);
    });

    it('ignores non-text content blocks', async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Welcome.' },
        ],
      });
      const { reply } = await converse(history);
      expect(reply).toBe('Welcome.');
    });
  });

  describe('extractIntent', () => {
    it('parses and validates the structured JSON output', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(validIntent) }],
      });
      const result = await extractIntent(history);
      expect(result.reasonForMeeting).toBe(validIntent.reasonForMeeting);
      expect(result.profileStrength).toBe('strong');
      expect(result.userCompany).toBe('Acme');
    });

    it('throws on invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not json at all' }],
      });
      await expect(extractIntent(history)).rejects.toThrow(/invalid json/i);
    });

    it('throws when the JSON fails schema validation', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ foo: 'bar' }) }],
      });
      await expect(extractIntent(history)).rejects.toThrow();
    });

    it('throws when there is no content', async () => {
      mockCreate.mockResolvedValue({ content: [] });
      await expect(extractIntent(history)).rejects.toThrow(/no content/i);
    });
  });
});
