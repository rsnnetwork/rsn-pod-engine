// ─── Want-matching precision (3 Aug 2026) ────────────────────────────────────
//
// Live report: a "Developers" agent whose want was "a react developer who can
// build my product" surfaced a CEO/Founder/Advisor, with the reason
// "matches their profile: can, build".
//
// Two filler words carried it: "can" and "build" each hit the candidate's
// profile text, and two matches score 0.667 overlap -> 0.467, just over the
// 0.45 bar. Words like these appear in almost every profile, so they must not
// be able to introduce two strangers on their own. Specific terms (react,
// saas, sourdough) and role designations still must.

import { scoreWants, scoreWantsForRecipient, IntentProfile } from '../../../services/matching/platform-match.service';
import { tokenizeTerms, normalizeDesignation, designationsWanted, ROLE_TAXONOMY } from '../../../services/matching/intent-signals';

const profile = (over: Partial<IntentProfile>): IntentProfile => ({
  id: 'u-x', displayName: 'X', avatarUrl: null,
  professionalRole: null, jobTitle: null, company: null,
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});

const WANT_DEVELOPER = 'a react developer who can build my product';

describe('filler words cannot introduce two strangers', () => {
  it.each(['can', 'build', 'help', 'work', 'need', 'product', 'business', 'company', 'new'])(
    '"%s" is not a matchable term',
    (word) => {
      expect(tokenizeTerms([word])).toEqual([]);
    },
  );

  it('does not match a CEO to a developer search on filler alone (the live report)', () => {
    const ceo = profile({
      id: 'u-ceo', displayName: 'Rachel L',
      professionalRole: ['CEO', 'Founder', 'Advisor'], company: 'Vdeep AI',
      whatICanHelpWith: 'I can help you build a company',
      whatICareAbout: 'building great products',
    });
    const { score } = scoreWants([WANT_DEVELOPER], ceo);
    expect(score).toBeLessThan(0.45);
  });
});

// The same live report, second half: three developer-ish members existed and
// the Developers agent matched none of them. Wanting "developers" produced no
// role hit at all, because the two designation lists never had a developer
// bucket — engineer/developer/designer/analyst were all filed as 'employee'.
describe('the roles people actually search for are recognised', () => {
  it.each([
    ['Senior React Engineer', 'developer'],
    ['Software Developer', 'developer'],
    ['Full Stack Engineer', 'developer'],
    ['Web & Software Engineer', 'developer'],
    ['Product Designer', 'designer'],
    ['Head of Marketing', 'marketer'],
    ['Sales Director', 'sales'],
    ['HR Business Partner', 'hr'],
  ])('%s reads as a %s', (title, expected) => {
    expect(normalizeDesignation(title)).toBe(expected);
  });

  it('a developer search finds a developer by role, not by chance wording', () => {
    const dev = profile({
      id: 'u-dev2', displayName: 'Sam',
      professionalRole: ['Developer'], jobTitle: 'Web & Software Engineer',
    });
    const { score, reason } = scoreWants(['developers and engineers'], dev);
    expect(score).toBeGreaterThanOrEqual(0.45);
    expect(reason).toMatch(/developer/i);
  });

  it('someone who OWNS a software company is an owner, not a developer', () => {
    expect(normalizeDesignation('owner of software company')).toBe('owner');
    const owner = profile({
      id: 'u-own', displayName: 'Nik',
      jobTitle: 'Director', professionalRole: ['owner of software company'],
    });
    expect(scoreWants(['developers and engineers'], owner).score).toBeLessThan(0.45);
  });

  it('the reason names the title that matched, never a different one', () => {
    // Live: matched on the job title "frontend engineer" but the sentence read
    // "is a Manager", because it printed the declared role instead.
    const engineerWhoIsAlsoAManager = profile({
      id: 'u-jack', displayName: 'jack rajaa',
      jobTitle: 'frontend engineer', professionalRole: ['Manager'],
    });
    const { reason } = scoreWants(['developers and engineers'], engineerWhoIsAlsoAManager);
    expect(reason).toMatch(/frontend engineer/i);
    expect(reason).not.toMatch(/is a Manager/i);
  });

  it('a developer search does not surface a marketer', () => {
    const marketer = profile({
      id: 'u-mkt', displayName: 'Mia', jobTitle: 'Head of Marketing',
    });
    expect(scoreWants(['developers and engineers'], marketer).score).toBeLessThan(0.45);
  });
});

// The bug underneath the bug: two rival role lists. This is the guard that
// keeps them one list forever.
describe('one taxonomy, both directions', () => {
  it('every role a person can BE is also a role someone can ASK FOR', () => {
    for (const bucket of ROLE_TAXONOMY) {
      const asked = designationsWanted(bucket.label).map(d => d.key);
      const findable = asked.includes(bucket.key) || !!bucket.wants;
      if (!findable) {
        throw new Error(`"${bucket.label}" (${bucket.key}) is not findable by anyone searching for it`);
      }
      expect(findable).toBe(true);
    }
  });

  it('covers every label the agent seeding can produce', () => {
    const seededLabels = [
      'founders and co-founders', 'investors, angels and VCs',
      'software developers and engineers', 'advisors and mentors',
      'customers and clients', 'partners and collaborators',
      'marketing leaders', 'sales leaders', 'HR directors and people leads',
      'manufacturers and suppliers', 'product and project managers',
      'CEOs and executives',
    ];
    for (const label of seededLabels) {
      if (designationsWanted(label).length === 0) {
        throw new Error(`no role bucket matches the seeded label "${label}"`);
      }
    }
  });
});

describe('real signals still match', () => {
  it('matches an actual react developer', () => {
    const dev = profile({
      id: 'u-dev', displayName: 'Dana',
      professionalRole: ['Developer'], jobTitle: 'Senior React Engineer',
      expertiseText: 'react typescript node',
    });
    const { score, reason } = scoreWants([WANT_DEVELOPER], dev);
    expect(score).toBeGreaterThanOrEqual(0.45);
    expect(reason).toBeTruthy();
  });

  it('matches an investor for an investor search', () => {
    const investor = profile({
      id: 'u-inv', displayName: 'Paul',
      professionalRole: ['Advisor', 'Investor'], company: 'Globadyme BV',
    });
    const { score } = scoreWants(['investors, angels and VCs'], investor);
    expect(score).toBeGreaterThanOrEqual(0.45);
  });

  it('still matches on a specific shared domain term, not just role', () => {
    const specialist = profile({
      id: 'u-s', displayName: 'Sam',
      jobTitle: 'Consultant', expertiseText: 'sourdough baking and viennoiserie',
    });
    const { score } = scoreWants(['someone who knows sourdough'], specialist);
    expect(score).toBeGreaterThan(0);
  });

  it('does not match an unrelated person', () => {
    const chef = profile({
      id: 'u-chef', displayName: 'Bilal',
      professionalRole: ['Pastry Chef'], expertiseText: 'sourdough croissants',
    });
    expect(scoreWants([WANT_DEVELOPER], chef).score).toBeLessThan(0.45);
  });
});

// ─── Who the introduction is addressed to (5 Aug 2026) ───────────────────────
//
// Live report: Ali's "Developers" agent found jack rajaa and sent an
// introduction. What jack received said "You're looking to meet founders —
// Raja Ali King is a Founder." True of jack's own profile, and completely the
// wrong reason: what reached him was Ali's DEVELOPERS agent. An introduction
// has to state the cause it actually came from, in the voice of whoever reads
// it.
describe('an introduction states its real cause, addressed to the reader', () => {
  const JACK = profile({
    id: 'u-jack', displayName: 'jack rajaa',
    professionalRole: ['Manager'], jobTitle: 'frontend engineer',
    whoIWantToMeet: 'founders building something new',
  });

  it('names the sender as the one looking, never the recipient', () => {
    const { reason } = scoreWantsForRecipient([WANT_DEVELOPER], JACK, 'Raja Ali King');
    expect(reason).toMatch(/^Raja Ali King is looking to meet/);
    expect(reason).not.toMatch(/You're looking to meet/);
  });

  it('names the designation the agent searched for and the title that matched', () => {
    const { reason } = scoreWantsForRecipient([WANT_DEVELOPER], JACK, 'Raja Ali King');
    expect(reason).toMatch(/developers and engineers/);
    expect(reason).toMatch(/you're a frontend engineer/);
    // The exact sentence that went out was about founders. It must not survive.
    expect(reason).not.toMatch(/founders/i);
  });

  it('addresses the recipient in the second person throughout', () => {
    const { reason } = scoreWantsForRecipient([WANT_DEVELOPER], JACK, 'Raja Ali King');
    expect(reason).not.toMatch(/jack rajaa/);
  });

  it('says the same thing to the seeker, in their voice', () => {
    const { reason } = scoreWants([WANT_DEVELOPER], JACK);
    expect(reason).toMatch(/^You're looking to meet developers and engineers/);
    expect(reason).toMatch(/jack rajaa is a frontend engineer/);
  });

  it('scores identically whichever voice is used — same rule, same numbers', () => {
    expect(scoreWantsForRecipient([WANT_DEVELOPER], JACK, 'Raja Ali King').score)
      .toBe(scoreWants([WANT_DEVELOPER], JACK).score);
  });

  it('falls back without inventing a reason when nothing fits', () => {
    const chef = profile({ id: 'u-c', displayName: 'Bilal', professionalRole: ['Pastry Chef'] });
    const { reason, score } = scoreWantsForRecipient(['react developers'], chef, 'Raja Ali King');
    expect(score).toBe(0);
    expect(reason).toBe('');
  });
});

// ─── "growth" and "brand" are not roles (6 Aug 2026) ─────────────────────────
//
// Live: a member whose text read "I am a Fractional COO working with
// growth-stage tech startups" had her agent classified as a marketing search —
// "growth-stage" is a company stage, not a job. Same shape as bare "software"
// making every owner of a software company a developer.
describe('company-stage and product words are not job roles', () => {
  it.each([
    'growth-stage tech startups',
    'a growth stage company',
    'building our brand new product',
    'brand new founders',
  ])('"%s" is not a marketing search', (text) => {
    expect(designationsWanted(text).map(d => d.key)).not.toContain('marketer');
  });

  it.each([
    'growth marketers',
    'a growth lead',
    'marketing leaders',
    'a brand manager',
    'branding help',
    'seo people',
  ])('"%s" still is', (text) => {
    expect(designationsWanted(text).map(d => d.key)).toContain('marketer');
  });

  it('does not match a Fractional COO describing her own company', () => {
    const text = 'I am a Fractional COO working with growth-stage tech startups, and looking to build a community with people!';
    expect(designationsWanted(text).map(d => d.key)).not.toContain('marketer');
  });
});

// ─── 13 Aug 2026 (B1): where the title came from decides what names the intro ─
describe('a stated title names the introduction; an inferred one defers to the stated role', () => {
  const dev = (jobTitleSource: 'stated' | 'inferred' | null) => profile({
    id: 'u-dev', displayName: 'Dana',
    professionalRole: ['Developer'], jobTitle: 'Senior React Developer',
    jobTitleSource,
  });

  it('stated: the specific title is the reason, not the generic role bucket', () => {
    const { reason, score } = scoreWants(['developers and engineers'], dev('stated'));
    expect(reason).toMatch(/Senior React Developer/);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('inferred: the role the member stated names it, and the score is the same', () => {
    const { reason, score } = scoreWants(['developers and engineers'], dev('inferred'));
    expect(reason).toMatch(/Developer/);
    expect(reason).not.toMatch(/Senior React Developer/);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('unknown provenance (pre-089 rows) behaves exactly as before: roles first', () => {
    const before = scoreWants(['developers and engineers'], dev(null));
    const inferred = scoreWants(['developers and engineers'], dev('inferred'));
    expect(before.reason).toBe(inferred.reason);
    expect(before.score).toBe(inferred.score);
  });

  it('an inferred title still counts when it is the only signal', () => {
    const only = profile({
      id: 'u-x', displayName: 'Sam', professionalRole: null,
      jobTitle: 'Growth Marketing Lead', jobTitleSource: 'inferred',
    });
    expect(scoreWants(['marketing people'], only).score).toBeGreaterThanOrEqual(0.6);
  });
});
