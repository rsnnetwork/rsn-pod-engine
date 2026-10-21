// ─── People who would also want to meet you come first (21 Oct 2026) ─────────
//
// The onboarding brief (19 Oct) promises potential mutuals: "On REASON, you connect with people
// you want to meet, who also want to meet you". Suggestions were one-way: what the member wants,
// against who the other person is and offers. Now, among the people that rule already chose, the
// ones whose own wants are a strong fit for the member come first.
//
// Wants are private (9 Sep rule; ledger ruling R8), so the order is the ONLY effect: the same
// people, as many as before, and the same cards word for word. The one number that could give
// the order away is the score. Masking it (a lifted card showed the highest score below it) still
// gave the order away inside a run of equal scores, which keep the id order unless someone was
// lifted (final review, 21 Oct). So a card's score is its band: 1 for a strong match, 0.5 for a
// close one, never the fit itself. Someone who passed on the member is never lifted. These tests
// pin all of it.

const mockQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/poke/poke.service', () => ({ sendPoke: jest.fn(), __esModule: true }));

import {
  getPlatformMatches, scoreFit, MATCH_THRESHOLD, BROWSE_THRESHOLD, IntentProfile, PlatformMatch,
} from '../../../services/matching/platform-match.service';

const profile = (over: Partial<IntentProfile>): IntentProfile => ({
  id: 'u-x', displayName: 'X', avatarUrl: null,
  professionalRole: null, jobTitle: null, company: null,
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});

// The member looking: a founder in Berlin raising a seed round.
const FATIMA = profile({
  id: 'u-fatima', displayName: 'Fatima', professionalRole: ['Founder'], location: 'Berlin, Germany',
  whoIWantToMeet: 'investors and angels for my seed round', myIntent: 'raise funding for my SaaS startup',
});

// Nobody below has curiosity fields (what they care about, their interests). Those are the one
// place where a person's own wants touch the score they are chosen by, so without them a want
// can change the order and nothing else, which is what the last tests compare.
const ANGEL = profile({ id: 'u-angel', displayName: 'Iqbal', professionalRole: ['Angel Investor'], expertiseText: 'early stage SaaS investing' });
const GP = profile({ id: 'u-gp', displayName: 'Nadia', professionalRole: ['General Partner'] });
const MIRA = profile({ id: 'u-mira', displayName: 'Mira', professionalRole: ['Investor'], whoIWantToMeet: 'founders' });
// Gita is Nadia with a want.
const GITA = profile({ id: 'u-gita', displayName: 'Gita', professionalRole: ['General Partner'], whoIWantToMeet: 'founders building SaaS' });
const OMAR = profile({
  id: 'u-omar', displayName: 'Omar', professionalRole: ['Startup Advisor'], expertiseText: 'seed funding rounds', whoIWantToMeet: 'founders',
});
// Two loose fits, equally loose. Maya would want to meet Fatima; Maryam would not.
const MARYAM = profile({ id: 'u-maryam', displayName: 'Maryam', professionalRole: 'Marketing Consultant', expertiseText: 'growth and funding narratives' });
const MAYA = { ...MARYAM, id: 'u-maya', displayName: 'Maya', whoIWantToMeet: 'founders' };
// Fits nothing Fatima wants, and would very much want to meet her.
const BILAL = profile({
  id: 'u-bilal', displayName: 'Bilal', professionalRole: ['Pastry Chef'], expertiseText: 'sourdough croissants', whoIWantToMeet: 'founders',
});

/** A row as the candidates query returns it. passedOnMember: they passed on the member. */
type Candidate = IntentProfile & { passedOnMember?: boolean | null };

function arm(viewer: IntentProfile, candidates: Candidate[]) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM sessions/.test(sql)) return Promise.resolve({ rows: [] });
    if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{ ...viewer, onboardingCompleted: true }] });
    return Promise.resolve({ rows: candidates });
  });
}

async function matchesFor(viewer: IntentProfile, candidates: Candidate[], opts: { browse?: boolean } = {}): Promise<PlatformMatch[]> {
  arm(viewer, candidates);
  return (await getPlatformMatches(viewer.id, opts)).matches;
}

async function orderFor(viewer: IntentProfile, candidates: Candidate[], opts: { browse?: boolean } = {}): Promise<string[]> {
  return (await matchesFor(viewer, candidates, opts)).map(m => m.userId);
}

/** No score on the list is higher than the one above it. A failure prints the scores. */
function expectNeverRises(ms: PlatformMatch[]) {
  const scores = ms.map(m => m.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
}

beforeEach(() => { mockQuery.mockReset(); mockTransaction.mockReset(); });

describe('the premise: who fits whom, one way and the other', () => {
  const oneWay = (p: IntentProfile) => scoreFit(FATIMA, p).score;
  const otherWay = (p: IntentProfile) => scoreFit(p, FATIMA).score;

  it('Fatima is a strong fit for what Mira, Gita, Omar, Maya and Bilal want; Iqbal, Nadia and Maryam want nothing', () => {
    for (const p of [MIRA, GITA, OMAR, MAYA, BILAL]) expect(otherWay(p)).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    for (const p of [ANGEL, GP, MARYAM]) expect(otherWay(p)).toBe(0);
  });

  it('one way, the people who want nothing score higher than the ones who would want to meet her', () => {
    expect(oneWay(ANGEL)).toBeGreaterThan(oneWay(MIRA));
    expect(oneWay(MIRA)).toBeGreaterThan(oneWay(GP));
    expect(oneWay(GP)).toBeGreaterThan(oneWay(OMAR));
    expect(oneWay(OMAR)).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(oneWay(GITA)).toBe(oneWay(GP));
    // Maryam and Maya are Close matches, Bilal no match at all.
    expect(oneWay(MAYA)).toBe(oneWay(MARYAM));
    expect(oneWay(MAYA)).toBeGreaterThanOrEqual(BROWSE_THRESHOLD);
    expect(oneWay(MAYA)).toBeLessThan(MATCH_THRESHOLD);
    expect(oneWay(BILAL)).toBe(0);
  });
});

describe('For You and Matches: people who would also want to meet you come first', () => {
  it('a mutual fit comes first even though its one-way score is lower, and no score shows the step', async () => {
    expect(scoreFit(FATIMA, GITA).score).toBeLessThan(scoreFit(FATIMA, ANGEL).score); // the premise
    const matches = await matchesFor(FATIMA, [ANGEL, GITA]);
    expect(matches.map(m => m.userId)).toEqual(['u-gita', 'u-angel']);
    // Gita's card shows Iqbal's score, not her own lower one: a score rising down the list
    // would mark her as someone whose private wants fit Fatima.
    expect(matches.map(m => m.score)).toEqual([1, 1]);
    expect(matches.map(m => m.strength)).toEqual(['strong', 'strong']);
  });

  it('two mutual fits keep today\'s order between them, and so do the people who fit one way', async () => {
    // Loaded shuffled. Today's order is by score: Iqbal, Mira, Nadia, Omar.
    expect(await orderFor(FATIMA, [OMAR, GP, MIRA, ANGEL])).toEqual(['u-mira', 'u-omar', 'u-angel', 'u-gp']);
  });

  it('equal scores keep the order they were loaded in (by id, see below), on both sides', async () => {
    const MIRA_2 = { ...MIRA, id: 'u-mira-2' };
    const ANGEL_2 = { ...ANGEL, id: 'u-angel-2' };
    expect(await orderFor(FATIMA, [ANGEL_2, MIRA_2, ANGEL, MIRA])).toEqual(['u-mira-2', 'u-mira', 'u-angel-2', 'u-angel']);
  });

  it('with nobody who would want to meet you back, the order is today\'s: best one-way score first', async () => {
    expect(await orderFor(FATIMA, [GP, ANGEL])).toEqual(['u-angel', 'u-gp']);
  });

  it('browse mode puts mutual fits first too', async () => {
    expect(await orderFor(FATIMA, [MARYAM, ANGEL, GITA], { browse: true })).toEqual(['u-gita', 'u-angel', 'u-maryam']);
  });
});

describe('a card\'s score is its band, so it cannot show who was lifted', () => {
  it('every strong card shows 1, whatever its own fit, and a lifted one looks like the rest', async () => {
    // Today, by fit: Iqbal 1, Mira 0.95, Nadia 0.6, Omar 0.56, all strong. Mira and Omar are lifted.
    expect(scoreFit(FATIMA, MIRA).score).not.toBe(scoreFit(FATIMA, OMAR).score); // the premise: four different fits
    const matches = await matchesFor(FATIMA, [OMAR, GP, MIRA, ANGEL]);
    expect(matches.map(m => [m.userId, m.strength, m.score])).toEqual([
      ['u-mira', 'strong', 1], ['u-omar', 'strong', 1], ['u-angel', 'strong', 1], ['u-gp', 'strong', 1],
    ]);
  });

  it('every close card shows 0.5, below every strong one', async () => {
    const matches = await matchesFor(FATIMA, [ANGEL, MARYAM, MAYA, GITA]);
    expect(matches.map(m => [m.userId, m.strength, m.score])).toEqual([
      ['u-gita', 'strong', 1], ['u-angel', 'strong', 1], ['u-maryam', 'close', 0.5], ['u-maya', 'close', 0.5],
    ]);
  });

  it('equal numbers say nothing about equal fits, so a card out of id order cannot be read as lifted', async () => {
    // The leak the band closes: equal fits keep the id order, so a card out of that order among
    // equal numbers was lifted. Now a better fit (Iqbal) shows the same number as the equal ones.
    const zed = { ...GITA, id: 'u-zed' };
    const plain = [{ ...GP, id: 'u-a' }, { ...GP, id: 'u-b' }];
    expect(scoreFit(FATIMA, zed).score).toBe(scoreFit(FATIMA, plain[0]).score); // the premise: one fit for these three
    expect(scoreFit(FATIMA, ANGEL).score).toBeGreaterThan(scoreFit(FATIMA, plain[0]).score); // ...and a better one
    const matches = await matchesFor(FATIMA, [ANGEL, ...plain, zed]);
    expect(matches.map(m => m.userId)).toEqual(['u-zed', 'u-angel', 'u-a', 'u-b']);
    expect(matches.map(m => m.score)).toEqual([1, 1, 1, 1]);
  });

  it('no card carries its fit to more than the band, in strict or browse mode', async () => {
    for (const browse of [false, true]) {
      const matches = await matchesFor(FATIMA, [ANGEL, MARYAM, MAYA, GITA, OMAR, GP, MIRA], { browse });
      for (const m of matches) expect(m.score).toBe(m.strength === 'strong' ? 1 : 0.5);
    }
  });

  it.each([
    ['one lifted above one', [ANGEL, GITA], false],
    ['two lifted, loaded shuffled', [OMAR, GP, MIRA, ANGEL], false],
    ['a Close fallback', [ANGEL, MARYAM, MAYA, GITA], false],
    ['browse', [MARYAM, ANGEL, GITA, OMAR, GP], true],
    ['nobody lifted', [GP, ANGEL, MARYAM], false],
  ] as Array<[string, Candidate[], boolean]>)('%s: no score is higher than the one above it', async (_label, pool, browse) => {
    const matches = await matchesFor(FATIMA, pool, { browse });
    expect(matches.length).toBeGreaterThan(1); // the premise: there is a list to read
    expectNeverRises(matches);
  });
});

describe('someone who passed on you is not lifted, and not pushed down either', () => {
  // Gita and Mira would want to meet Fatima on their wants alone. Here they passed on her ("not relevant").
  it('a Pass keeps a would-be mutual fit where today\'s order puts her', async () => {
    expect(await orderFor(FATIMA, [ANGEL, { ...GITA, passedOnMember: true }])).toEqual(['u-angel', 'u-gita']);
  });

  it('she keeps her place among the others: not lifted above them, not dropped below them', async () => {
    // Today: Iqbal 1, Mira 0.95, Nadia 0.6, Omar 0.56. Omar is lifted; Mira passed on Fatima, so she is not.
    expect(await orderFor(FATIMA, [OMAR, GP, { ...MIRA, passedOnMember: true }, ANGEL]))
      .toEqual(['u-omar', 'u-angel', 'u-mira', 'u-gp']);
  });

  it('only a Pass counts: a Save, or no response at all, still lifts her', async () => {
    expect(await orderFor(FATIMA, [ANGEL, { ...GITA, passedOnMember: false }])).toEqual(['u-gita', 'u-angel']);
    expect(await orderFor(FATIMA, [ANGEL, { ...GITA, passedOnMember: null }])).toEqual(['u-gita', 'u-angel']);
  });

  it('the Pass is read in the candidates query itself: their own response, about the member', async () => {
    arm(FATIMA, []);
    await getPlatformMatches('u-fatima');
    const candidatesSql = String(mockQuery.mock.calls.find(c => /u\.id <> \$1/.test(String(c[0])))![0]);
    expect(candidatesSql).toMatch(/LEFT JOIN person_responses prb ON prb\.user_id = u\.id AND prb\.target_user_id = \$1/);
    expect(candidatesSql).toMatch(/\(prb\.response = 'passed'\) AS "passedOnMember"/);
  });
});

describe('the same order on every load', () => {
  it('the candidates come back ordered by id, so people with equal scores never swap places', async () => {
    arm(FATIMA, []);
    await getPlatformMatches('u-fatima');
    const candidatesSql = String(mockQuery.mock.calls.find(c => /u\.id <> \$1/.test(String(c[0])))![0]);
    expect(candidatesSql).toMatch(/ORDER BY u\.id\s*$/);
  });
});

describe('a Close match stays below every strong one', () => {
  it('a loose fit is not lifted by wanting to meet you, and keeps its label', async () => {
    // Two strong fits, so the closest people are added, labelled. Maryam and Maya fit Fatima
    // equally loosely, so they stay in the order they were loaded in, whatever Maya wants.
    const matches = await matchesFor(FATIMA, [ANGEL, MARYAM, MAYA, GITA]);
    expect(matches.map(m => [m.userId, m.strength])).toEqual([
      ['u-gita', 'strong'], ['u-angel', 'strong'], ['u-maryam', 'close'], ['u-maya', 'close'],
    ]);
    expect(matches.find(m => m.userId === 'u-maya')!.reason).toMatch(/^Close match — /);
  });
});

describe('wanting to meet you never adds anyone', () => {
  it('someone who fits nothing you want is not shown, however much they would want to meet you', async () => {
    expect(await orderFor(FATIMA, [BILAL, ANGEL])).toEqual(['u-angel']);
    expect(await orderFor(FATIMA, [BILAL, ANGEL], { browse: true })).toEqual(['u-angel']);
  });

  it('a place you named stays strict: someone elsewhere who would want to meet you is not shown', async () => {
    const wantsGermany = { ...FATIMA, whoIWantToMeet: 'investors and angels in Germany for my seed round' };
    const BEN = profile({ id: 'u-ben', displayName: 'Ben', professionalRole: ['Investor'], location: 'Munich, Germany' });
    const PAUL = profile({ id: 'u-paul', displayName: 'Paul', professionalRole: ['Investor'], location: 'Paris, France', whoIWantToMeet: 'founders' });
    expect(scoreFit(PAUL, wantsGermany).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD); // the premise
    expect(await orderFor(wantsGermany, [PAUL, BEN])).toEqual(['u-ben']);
    expect(await orderFor(wantsGermany, [PAUL, BEN], { browse: true })).toEqual(['u-ben']);
  });

  it('years you asked for stay strict: someone with fewer who would want to meet you is not shown', async () => {
    const wantsTenYears = { ...FATIMA, whoIWantToMeet: 'investors with 10 years experience' };
    const FAY = profile({ id: 'u-fay', displayName: 'Fay', professionalRole: ['Investor'], bio: '5 years investing in startups', whoIWantToMeet: 'founders' });
    const TOM = profile({ id: 'u-tom', displayName: 'Tom', professionalRole: ['Investor'], bio: '20 years investing in startups' });
    expect(scoreFit(FAY, wantsTenYears).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD); // the premise
    expect(await orderFor(wantsTenYears, [FAY, TOM])).toEqual(['u-tom']);
    expect(await orderFor(wantsTenYears, [FAY, TOM], { browse: true })).toEqual(['u-tom']);
  });
});

describe('not wanting to meet you never removes anyone', () => {
  it('someone whose want names a place you are not in is still shown, where they are today', async () => {
    const JUN = profile({ id: 'u-jun', displayName: 'Jun', professionalRole: ['Investor'], whoIWantToMeet: 'founders in Japan' });
    const BEN = profile({ id: 'u-ben', displayName: 'Ben', professionalRole: ['Investor'], whoIWantToMeet: 'founders in Germany' });
    // The premise: Fatima is in Berlin, so only Ben's place holds for her.
    expect(scoreFit(JUN, FATIMA).score).toBe(0);
    expect(scoreFit(BEN, FATIMA).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(scoreFit(FATIMA, JUN).score).toBe(scoreFit(FATIMA, BEN).score);
    // Today: Jun, Ben (equal scores, as loaded), Nadia.
    expect(await orderFor(FATIMA, [JUN, GP, BEN])).toEqual(['u-ben', 'u-jun', 'u-gp']);
  });

  it('someone who asks for more years than you state is still shown', async () => {
    const fiveYears = { ...FATIMA, bio: 'I have 5 years of experience building startups' };
    const YARA = profile({ id: 'u-yara', displayName: 'Yara', professionalRole: ['Investor'], whoIWantToMeet: 'founders with 10 years experience' });
    expect(scoreFit(YARA, fiveYears).score).toBe(0); // the premise
    expect(scoreFit(fiveYears, YARA).score).toBeGreaterThan(scoreFit(fiveYears, GITA).score);
    expect(await orderFor(fiveYears, [GITA, YARA])).toEqual(['u-gita', 'u-yara']);
  });
});

describe('the same people, as many as before', () => {
  const angels = Array.from({ length: 10 }, (_, i) => ({ ...ANGEL, id: `u-angel-${i + 1}`, displayName: `Angel ${i + 1}` }));
  const gitas = [{ ...GITA, id: 'u-gita-1' }, { ...GITA, id: 'u-gita-2' }];

  it('ten places: a mutual fit who was not among today\'s ten is not pulled in', async () => {
    const matches = await matchesFor(FATIMA, [...gitas, ...angels]);
    expect(matches.map(m => m.userId)).toEqual(angels.map(a => a.id));
  });

  it('a mutual fit among today\'s ten moves to the top, and the ten stay the same ten', async () => {
    const nine = angels.slice(0, 9);
    // Today's ten: the nine angels, then Gita 1 (Gita 2 scores the same and was loaded after her).
    const matches = await matchesFor(FATIMA, [...nine, ...gitas]);
    expect(matches.map(m => m.userId)).toEqual(['u-gita-1', ...nine.map(a => a.id)]);
  });
});

describe('the cards are today\'s cards, word for word', () => {
  // The same people without their wants: nobody would want to meet Fatima back, so that list is
  // exactly the one-way rule's. With their wants, only the order moves; every card, its score
  // included, is the same.
  const withoutWants = (p: IntentProfile): IntentProfile => ({ ...p, whoIWantToMeet: null, whyIWantToMeet: null, myIntent: null, goals: null });
  const byId = (ms: PlatformMatch[]) => Object.fromEntries(ms.map(m => [m.userId, m]));

  it.each([
    ['a Close fallback, strict', [ANGEL, MARYAM, MAYA, GITA, BILAL], false, ['u-gita', 'u-angel', 'u-maryam', 'u-maya'], [1, 1, 0.5, 0.5]],
    ['a Close fallback, browse', [ANGEL, MARYAM, MAYA, GITA, BILAL], true, ['u-gita', 'u-angel', 'u-maryam', 'u-maya'], [1, 1, 0.5, 0.5]],
    ['strong fits only', [OMAR, GP, MIRA, ANGEL, BILAL], false, ['u-mira', 'u-omar', 'u-angel', 'u-gp'], [1, 1, 1, 1]],
  ] as Array<[string, Candidate[], boolean, string[], number[]]>)(
    '%s: the same people with the same cards; only the order moves',
    async (_label, pool, browse, expected, scores) => {
      const mutual = await matchesFor(FATIMA, pool, { browse });
      const oneWay = await matchesFor(FATIMA, pool.map(withoutWants), { browse });
      expect(mutual.map(m => m.userId)).toEqual(expected);
      expect(oneWay.map(m => m.userId)).not.toEqual(expected); // the premise: the order did move
      expect(mutual.map(m => m.userId).sort()).toEqual(oneWay.map(m => m.userId).sort());
      expect(byId(mutual)).toEqual(byId(oneWay));
      expect(mutual.map(m => m.score)).toEqual(scores);
    },
  );
});

describe('no new field', () => {
  const MATCH_KEYS = [
    'avatarUrl', 'company', 'displayName', 'industry', 'pokeSentByOwner', 'pokeStatus', 'professionalRole',
    'reason', 'saved', 'score', 'strength', 'theyCanBring', 'userId',
  ];
  const PAYLOAD_KEYS = ['matches', 'nextEvent', 'profileIncomplete', 'youAreLookingFor'];

  it.each([false, true])('browse %s: a mutual fit\'s card has the fields every card has, and the payload has today\'s', async (browse) => {
    arm(FATIMA, [ANGEL, GITA, MARYAM, { ...MIRA, passedOnMember: true }]);
    const res = await getPlatformMatches('u-fatima', { browse });
    expect(res.matches[0].userId).toBe('u-gita'); // the premise: a mutual fit is on the list...
    expect(res.matches.map(m => m.userId)).toContain('u-mira'); // ...and someone who passed on Fatima
    expect(Object.keys(res).sort()).toEqual(PAYLOAD_KEYS);
    for (const m of res.matches) expect(Object.keys(m).sort()).toEqual(MATCH_KEYS);
    expect(JSON.stringify(res)).not.toMatch(/passed/i);
  });

  it('nothing of a mutual fit\'s wants reaches the response', async () => {
    const SANA = profile({
      id: 'u-sana', displayName: 'Sana', professionalRole: ['General Partner'],
      whoIWantToMeet: 'founders zzsecretwho', whyIWantToMeet: 'zzsecretwhy', myIntent: 'zzsecretintent', goals: ['zzsecretgoal'],
    });
    arm(FATIMA, [ANGEL, SANA]);
    const res = await getPlatformMatches('u-fatima');
    expect(res.matches.map(m => m.userId)).toEqual(['u-sana', 'u-angel']); // the premise: she is a mutual fit
    expect(JSON.stringify(res)).not.toMatch(/zzsecret/);
  });
});

describe('no extra query: the other direction reads the rows already loaded', () => {
  async function queriesFor(candidates: IntentProfile[]): Promise<string[]> {
    mockQuery.mockReset();
    arm(FATIMA, candidates);
    await getPlatformMatches('u-fatima');
    return mockQuery.mock.calls.map(c => String(c[0]));
  }

  it('three queries whatever the pool: the member, the next event and the candidates', async () => {
    const angels = Array.from({ length: 10 }, (_, i) => ({ ...ANGEL, id: `u-angel-${i + 1}` }));
    const none = await queriesFor([]);
    const two = await queriesFor([ANGEL, GITA]);
    const many = await queriesFor([...angels, MIRA, GITA, OMAR, MAYA, BILAL]);
    expect(none).toHaveLength(3);
    expect(two).toEqual(none);
    expect(many).toEqual(none);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('the candidates query already carries each person\'s wants', async () => {
    const candidatesSql = (await queriesFor([GITA])).find(s => /u\.id <> \$1/.test(s))!;
    for (const column of ['u.who_i_want_to_meet', 'u.why_i_want_to_meet', 'u.my_intent', 'u.goals']) {
      expect(candidatesSql).toContain(column);
    }
  });
});
