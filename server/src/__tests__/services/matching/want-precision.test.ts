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

import { scoreWants, IntentProfile } from '../../../services/matching/platform-match.service';
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
