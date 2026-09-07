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

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config', () => ({
  __esModule: true,
  default: {
    anthropicApiKey: 'test-key',
    onboardingChatModel: 'claude-haiku-4-5',
    onboardingExtractModel: 'claude-haiku-4-5',
  },
}));

import { converse, extractIntent, isEnabled, styleViolations } from '../../../services/onboarding/chatbot.service';
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
  userLanguages: ['English'],
  problemTheySolve: 'helps B2B teams shorten their sales cycle',
  authorityLevel: 'final decision maker',
  needsHelpWith: ['finding pilot customers'],
  meetingValueCriteria: 'a concrete intro to a warm pilot customer',
  restrictions: {
    noCompetitors: false,
    competitorNote: null,
    geography: [],
    industriesToAvoid: [],
    seniorityToAvoid: [],
    requiredLanguages: [],
  },
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

  // 7 Sep 2026 (Ali): "it must be easy to talk and to the point". A draft that
  // breaks the hard style rules is sent back once for a rewrite; a compliant
  // draft costs nothing extra; a rewrite that is no better never blocks the chat.
  // 7 Sep 2026: a bare ready token used to become an empty assistant message
  // that every later request failed validation on.
  describe('an empty reply never reaches the transcript', () => {
    beforeEach(() => mockCreate.mockReset());
    it('a bare ready token becomes a short closing line, still ready', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: READY_TOKEN }] });
      const { reply, ready } = await converse(history);
      expect(ready).toBe(true);
      expect(reply).toBe('Thank you, that is everything we need.');
    });
    it('an empty reply becomes a question, not an empty line', async () => {
      mockCreate.mockResolvedValue({ content: [] });
      const { reply, ready } = await converse(history);
      expect(ready).toBe(false);
      expect(reply).toBe('Could you tell us a bit more?');
    });
  });

  describe('style guard', () => {
    beforeEach(() => mockCreate.mockReset());

    it('a compliant draft goes out with a single call', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Got it. Who would be most useful to meet?' }] });
      const { reply } = await converse(history);
      expect(reply).toBe('Got it. Who would be most useful to meet?');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('an "A or B?" question is rewritten once, and the rewrite is used', async () => {
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Makes sense. Are you after farmers already using new tech, or ones open to it?' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Makes sense. Which farmers would you most want to meet?' }] });
      const { reply } = await converse(history);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockCreate.mock.calls[1][0].system).toContain('REWRITE');
      expect(mockCreate.mock.calls[1][0].system).toContain('alternatives');
      expect(reply).toBe('Makes sense. Which farmers would you most want to meet?');
    });

    it('a rewrite that is no better falls back to the first draft instead of failing', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Do you want A, or B? And why?' }] });
      const { reply } = await converse(history);
      expect(reply).toBe('Do you want A, or B? And why?');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('a failing rewrite call still returns the first draft', async () => {
      mockCreate
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Interesting. What is the plan, or is it early days?' }] })
        .mockRejectedValueOnce(new Error('model down'));
      const { reply } = await converse(history);
      expect(reply).toBe('Interesting. What is the plan, or is it early days?');
    });

    it('names each rule a draft breaks', () => {
      expect(styleViolations("Got it. So you're solving invoicing pain for freelancers. Who do you want to meet?", false)).toContain('it reads their answer back to them');
      expect(styleViolations('You have real wins there.', false)).toContain('it asks no question');
      expect(styleViolations('Who? And why?', false)).toContain('it asks more than one question');
      expect(styleViolations('Makes sense. Which farmers would you most want to meet?', false)).toEqual([]);
      // The closing summary only has to stay short.
      expect(styleViolations('Here is what we heard, in one line. ' + READY_TOKEN, true)).toEqual([]);
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

    // The 35-field schema exceeds the API's structured-output grammar compiler
    // limit ("The compiled grammar is too large" 400) — every prod extraction
    // failed while mocked tests stayed green. The contract now travels in the
    // prompt instead, so no request may carry an output_config grammar.
    it('sends no output_config grammar and embeds the JSON contract in the prompt', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(validIntent) }],
      });
      await extractIntent(history);
      const req = mockCreate.mock.calls[0][0];
      expect(req.output_config).toBeUndefined();
      const prompt = req.messages[0].content as string;
      expect(prompt).toContain('"restrictions"');
      expect(prompt).toContain('"confidenceScores"');
      expect(prompt).toMatch(/only.*json/i);
    });

    it('parses a reply wrapped in markdown code fences', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(validIntent) + '\n```' }],
      });
      const result = await extractIntent(history);
      expect(result.userCompany).toBe('Acme');
    });

    it('parses a reply with prose before and after the JSON object', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Here is the extraction:\n' + JSON.stringify(validIntent) + '\nDone.' }],
      });
      const result = await extractIntent(history);
      expect(result.profileStrength).toBe('strong');
    });
  });
});
