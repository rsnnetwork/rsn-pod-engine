import { FIRST_QUESTION, buildHostSystemPrompt } from '../../../services/onboarding/prompts';

const EM_OR_EN_DASH = /[—–]/;

describe('onboarding prompts (v1.1)', () => {
  it('the first chat question contains no dashes', () => {
    expect(EM_OR_EN_DASH.test(FIRST_QUESTION)).toBe(false);
    expect(FIRST_QUESTION.includes(' - ')).toBe(false);
  });

  it('the host system prompt forbids dashes', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('never use dashes');
  });

  it('weaves the confirmed profile in so the host never re-asks', () => {
    const p = buildHostSystemPrompt({ name: 'Stefan', country: 'Denmark', company: 'Mister Raw' });
    expect(p).toContain('Stefan');
    expect(p).toContain('Denmark');
    expect(p).toContain('Mister Raw');
    expect(p).toContain('already KNOW');
  });

  it('weaves the full enriched profile + briefing (starters, verify) into the host', () => {
    const p = buildHostSystemPrompt(
      { name: 'Stefan', country: 'Denmark', company: 'Mister Raw' },
      'none',
      {
        role: 'Founder', industry: 'FoodTech', about: 'Builds raw pet food',
        wantsToMeet: ['investors'], offers: ['mentorship'], interests: ['nutrition'], whyHere: 'scale my brand',
        conversationStarters: ['Saw you scaled Mister Raw across the Nordics'],
        questionsToVerify: ['Are you still focused on pet nutrition'],
      }
    );
    expect(p).toContain('Founder');
    expect(p).toContain('investors');
    expect(p).toContain('mentorship');
    expect(p).toContain('scale my brand');
    expect(p).toContain('Saw you scaled Mister Raw across the Nordics'); // conversation starter
    expect(p).toContain('Are you still focused on pet nutrition'); // verify question
  });

  it('omits the known block when no profile is given', () => {
    expect(buildHostSystemPrompt()).not.toContain('CONFIRMED');
  });

  it('instructs the host to wrap up efficiently', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('wrapping up sooner');
    expect(p).toContain('go straight to the summary');
  });

  it('includes the Round B optional dimensions (valuable to / invite)', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('valuable to');
    expect(p).toContain('invite');
  });

  it('injects the right finish instruction per wrapMode', () => {
    expect(buildHostSystemPrompt(undefined, 'hard')).toContain('asked to finish');
    expect(buildHostSystemPrompt(undefined, 'soft')).toContain('wants to finish');
    expect(buildHostSystemPrompt(undefined, 'soft').toLowerCase()).toContain('they can skip');
    const none = buildHostSystemPrompt(undefined);
    expect(none).not.toContain('asked to finish');
    expect(none).not.toContain('wants to finish');
  });

  describe('honesty clause (driven by enrichment state)', () => {
    const RETRIEVED = 'retrieved parts of their public profile';
    const NOT_RETRIEVED = 'we could not retrieve their profile';

    it('found: instructs the host to confirm retrieved facts and never invent beyond the known block', () => {
      const p = buildHostSystemPrompt(undefined, 'none', undefined, 'found').toLowerCase();
      expect(p).toContain(RETRIEVED);
      expect(p).toContain('never invent');
      expect(p).not.toContain(NOT_RETRIEVED);
    });

    it('partial: gets the same retrieved-profile honesty clause as found', () => {
      const p = buildHostSystemPrompt(undefined, 'none', undefined, 'partial').toLowerCase();
      expect(p).toContain(RETRIEVED);
      expect(p).not.toContain(NOT_RETRIEVED);
    });

    it.each([['not_found'], ['none'], ['failed'], ['searching'], [undefined]])(
      'treats %s as not retrieved: never implies a review happened, builds the profile together from answers',
      (status) => {
        const p = buildHostSystemPrompt(undefined, 'none', undefined, status as any).toLowerCase();
        expect(p).toContain(NOT_RETRIEVED);
        expect(p).toContain('build their profile together');
        expect(p).not.toContain(RETRIEVED);
      }
    );

    it('the two honesty clauses are mutually exclusive', () => {
      const found = buildHostSystemPrompt(undefined, 'none', undefined, 'found').toLowerCase();
      const notFound = buildHostSystemPrompt(undefined, 'none', undefined, 'not_found').toLowerCase();
      expect(found).toContain(RETRIEVED);
      expect(found).not.toContain(NOT_RETRIEVED);
      expect(notFound).toContain(NOT_RETRIEVED);
      expect(notFound).not.toContain(RETRIEVED);
    });

    it('the honesty clause text contains no dashes (style rule)', () => {
      const found = buildHostSystemPrompt(undefined, 'none', undefined, 'found');
      const notFound = buildHostSystemPrompt(undefined, 'none', undefined, 'not_found');
      expect(EM_OR_EN_DASH.test(found)).toBe(false);
      expect(EM_OR_EN_DASH.test(notFound)).toBe(false);
    });
  });
});
