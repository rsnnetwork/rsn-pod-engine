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

  // 10 Sep 2026 (Claus): nothing about the member is ASKED as a profile field.
  // Language, competitors, geography and invites are noted if mentioned.
  it('never asks the member to describe their profile; notes invites if mentioned', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('never ask people to describe their profile');
    expect(p).toContain('invite');
    expect(p).toContain('never ask for these');
  });

  // 10 Sep 2026 (Claus): three OPEN questions. The opening is universal and
  // fixed (asked by the client/route, not generated); the second and third are
  // adaptive, with Claus's defaults named so the host has the shape.
  describe("Claus's arc: opening, adaptive exploration, adaptive value", () => {
    it('names the three openings in order and says the first is already asked', () => {
      const p = buildHostSystemPrompt();
      const i1 = p.indexOf('what brought them here');
      const i2 = p.indexOf("What's taking up your attention these days?");
      const i3 = p.indexOf('And if being here turned out to be genuinely valuable, what might come from it?');
      expect(i1).toBeGreaterThan(-1);
      expect(i2).toBeGreaterThan(i1);
      expect(i3).toBeGreaterThan(i2);
      expect(p.toLowerCase()).toContain('the opening has already been asked');
    });

    it('never asks the defaults mechanically: adapt from the answer, skip what it already covered', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('do not ask it mechanically');
      expect(p).toContain('ask the thing their answer leaves open');
      expect(p).toContain('never ask people to describe their profile');
      expect(p).toContain('list who they want to meet');
      expect(p).toContain('becomes visible on its own');
    });

    it('allows one reflection as a statement, with Claus\'s example, and one follow-up per opening at most', () => {
      const p = buildHostSystemPrompt();
      expect(p.toLowerCase()).toContain('a reflection is different from reading back');
      expect(p).toContain('less about finding the next company, and more about what deserves to be next.');
      expect(p.toLowerCase()).toContain('as a statement, never as a question');
      expect(p.toLowerCase()).toContain('at most one short follow-up per opening');
    });

    it('reads like a spoken conversation', () => {
      expect(buildHostSystemPrompt().toLowerCase()).toContain('spoken conversation');
    });

    it('carries the server-side progress count into the prompt', () => {
      const p = buildHostSystemPrompt(undefined, 'none', undefined, undefined, { asked: 3, max: 6 });
      expect(p).toContain('So far you have asked 3 of at most 6.');
      expect(buildHostSystemPrompt()).not.toContain('So far you have asked');
    });

    it('a soft finish asks the value question once if it is still open, never what they offer', () => {
      const soft = buildHostSystemPrompt(undefined, 'soft').toLowerCase();
      expect(soft).toContain('what might come from being here');
      expect(soft).not.toContain('what they can help others with');
    });

    it('there is no generated opening mode any more', () => {
      expect(buildHostSystemPrompt()).not.toContain('OPENING TURN');
    });
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

    it('who they want to meet and what they bring are read from the conversation, not asked', () => {
      const p = buildHostSystemPrompt().toLowerCase();
      expect(p).toContain('what they want and what they bring becomes visible on its own');
      expect(p).not.toContain('who would be valuable for them to meet');
    });

    // 7 Sep 2026 (Ali, from his own chat): every turn read his answer back to
    // him and then asked a two-part question. The budget is tighter now, the
    // reaction is three words at most, and the question stands alone.
    it('the word budget is tight and a reaction is three words at most', () => {
      const p = buildHostSystemPrompt();
      const m = p.match(/under (\d+) words/);
      expect(Number(m![1])).toBeLessThanOrEqual(30);
      expect(Number(m![1])).toBeGreaterThanOrEqual(20);
      expect(p.toLowerCase()).toContain('never repeat or paraphrase what they just said');
      expect(p.toLowerCase()).toContain('at most three words');
      expect(p.toLowerCase()).toContain('at most 15 words');
      expect(p.toLowerCase()).toContain('never offer alternatives inside the question');
      // 10 Sep 2026 (Claus): three openings plus at most three follow-ups.
      expect(p.toLowerCase()).toContain('at most six questions in the whole chat');
      expect(p.toLowerCase()).toContain('accept brief answers as final');
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

    it('keeps these light: noted if mentioned, never a question of their own', () => {
      const p = buildHostSystemPrompt();
      // 10 Sep 2026 (Claus): the arc is exactly three numbered openings; the
      // language / competitor / geography / invite line is "take note; never
      // ask for these", not a fourth station.
      const numberedItems = p.match(/^\s*\d+\.\s+(The opening|Exploration|Value)/gm) || [];
      expect(numberedItems.length).toBe(3);
      expect(p.toLowerCase()).toContain('take note; never ask for these');
    });

    it('contains no dashes (style rule)', () => {
      const p = buildHostSystemPrompt();
      expect(EM_OR_EN_DASH.test(p)).toBe(false);
    });
  });

  // 10 Sep 2026 (Claus): the profile is READ out of three open answers. The
  // extractor must infer wants and offers from them (never invent facts).
  describe('extraction reads wants and offers out of open answers', () => {
    const p = EXTRACTION_PROMPT.toLowerCase();
    it('knows the member was never asked to classify themselves', () => {
      expect(p).toContain('never asked to describe themselves or to list who they want to meet');
      expect(p).toContain('what brought them here');
      expect(p).toContain('what has their attention');
      expect(p).toContain('what might come from being here');
    });
    it('infers wants and offers, never facts', () => {
      expect(p).toContain('may be inferred');
      expect(p).toContain('are never invented');
      expect(p).toContain('figuring out what to build next');
      expect(p).toContain('inferred means lower');
    });
    it('has a rule for every field matching consumes', () => {
      for (const f of ['reasonformeeting:', 'desiredoutcome:', 'currentfocus:', 'userexpertise', 'usercanoffer', 'userinterests:', 'userprofilesummary:']) {
        expect(p).toContain(f);
      }
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
