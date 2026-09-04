import { buildHostSystemPrompt, EXTRACTION_PROMPT } from '../../../services/onboarding/prompts';

const EM_OR_EN_DASH = /[—–]/;

describe('onboarding prompts (v1.1)', () => {
  // 30 Jul 2026 — "every step should ask one clear question and stop". The
  // prompt previously carried a single soft brevity line against seven
  // counter-pressures that pushed the host toward paragraphs.
  it('the host is instructed to ask exactly one question and keep messages short', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('one question per message');
    expect(p).toMatch(/never stack two questions/);
    expect(p).toMatch(/under \d+ words/);
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

  // 4 Sep 2026: the chat used to open on a fixed line that ignored the card.
  it('the opening turn reads the card back and asks what the reason leaves open, never the reason itself', () => {
    const p = buildHostSystemPrompt(undefined, 'opening');
    expect(p).toContain('OPENING TURN');
    expect(p).toMatch(/never quote it or answer it/);
    expect(p).toMatch(/never ask what brings them here/);
    expect(p).toMatch(/never the ready token/);
    expect(buildHostSystemPrompt(undefined, 'none')).not.toContain('OPENING TURN');
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
    // Source-agnostic wording: the known profile block can be populated from
    // on-file columns (job_title/company/bio) as readily as from a genuine
    // LinkedIn hit (see getKnownProfileForHost's on-file-first fallback), so
    // the clause must never claim a specific retrieval that may not have
    // happened. It speaks of "what we already have", not "retrieved... public
    // profile".
    const RETRIEVED = 'what we already have for them';
    const NOT_RETRIEVED = 'we could not retrieve their profile';

    it('found: instructs the host to confirm the known facts and never invent beyond the known block, without claiming a specific retrieval', () => {
      const p = buildHostSystemPrompt(undefined, 'none', undefined, 'found').toLowerCase();
      expect(p).toContain(RETRIEVED);
      expect(p).toContain('never invent');
      expect(p).not.toContain(NOT_RETRIEVED);
    });

    it('partial: gets the same known-facts honesty clause as found', () => {
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

  // 13 Aug 2026: Stefan: "The prompt is too transactional and cold; it needs
  // to feel more human." The efficiency rules stay. What changes is that the
  // host reacts to what the member just said before it asks the next thing.
  describe('the host sounds like a person (13 Aug)', () => {
    it('reacts to what the member said before asking the next thing, one question at a time', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('react to what they just said');
      expect(p).toContain('one question at a time');
    });

    it('does not flatter, fake enthusiasm, or interrogate', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('no flattery');
      expect(p).toContain('in their own words');
      expect(p).toContain('interrogat');
    });

    it('still collects who they want to meet and who they would be valuable to', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('valuable for them to meet');
      expect(p).toContain('valuable to');
    });

    it('a reaction plus one question still fits the word budget', () => {
      const m = buildHostSystemPrompt().match(/under (\d+) words/);
      expect(Number(m![1])).toBeGreaterThanOrEqual(35);
    });

    it('the tone rules contain no dashes (style rule)', () => {
      expect(EM_OR_EN_DASH.test(buildHostSystemPrompt())).toBe(false);
    });
  });

  describe('C2: host guidance naturally asks about languages, meeting value, and restrictions', () => {
    it('weaves in a language question', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('language');
    });

    it('weaves in what would make a meeting valuable', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('valuable');
    });

    it('weaves in who they do NOT want to meet, mentioning competitors and geography', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('competitor');
      expect(p).toContain('geography');
    });

    it('keeps these light: folded into the existing guidance, no new mandatory station added', () => {
      const p = buildHostSystemPrompt();
      // The "in order of importance" list stays at 3 items: the new content is
      // woven into those, not appended as a 4th mandatory station.
      const section = p.split('in order of importance:')[1]?.split(/\n\n/)[0] || '';
      const numberedItems = section.match(/^\s*\d+\.\s/gm) || [];
      expect(numberedItems.length).toBeLessThanOrEqual(3);
    });

    it('contains no dashes (style rule)', () => {
      const p = buildHostSystemPrompt();
      expect(EM_OR_EN_DASH.test(p)).toBe(false);
    });
  });
});

describe('EXTRACTION_PROMPT (C2 additions)', () => {
  const p = EXTRACTION_PROMPT.toLowerCase();

  it('instructs extraction of userLanguages', () => {
    expect(p).toContain('userlanguages');
  });

  it('instructs extraction of problemTheySolve', () => {
    expect(p).toContain('problemtheysolve');
  });

  it('instructs extraction of authorityLevel', () => {
    expect(p).toContain('authoritylevel');
  });

  it('instructs extraction of needsHelpWith, distinct from desiredOutcome', () => {
    expect(p).toContain('needshelpwith');
  });

  it('instructs extraction of meetingValueCriteria', () => {
    expect(p).toContain('meetingvaluecriteria');
  });

  it('instructs extraction of every restrictions sub-field', () => {
    expect(p).toContain('nocompetitors');
    expect(p).toContain('competitornote');
    expect(p).toContain('industriestoavoid');
    expect(p).toContain('senioritytoavoid');
    expect(p).toContain('requiredlanguages');
  });

  it('never infer restrictions that were not stated', () => {
    expect(p).toContain('never invent a restriction');
  });

  // 3 Sep 2026: Stefan answered "I need a developer" and the extractor set
  // userRole to "developer"; the save wrote it into professional_role and he
  // surfaced in every Developers agent. The prompt never said what userRole IS.
  it('userRole is the member\'s own role, never the role they are looking for', () => {
    expect(p).toContain('userrole: the member\'s own current role');
    expect(p).toContain('never the kind of person they are looking for');
    expect(p).toContain('"i need a developer", userrole is not "developer"');
  });
});
