// server/src/__tests__/client/reason-m1-profile-text.test.ts
// What the Human Profile says, and the small rules behind it, EXECUTED. profile-text.ts has no React, axios,
// store or router behind it, so a test can import it, the way errors.ts and person.ts are run in
// reason-m1-data-layer.test.ts. The markup and wiring are pinned by reading the source in reason-m1-profile.test.ts.
import * as fs from 'fs';
import * as path from 'path';
import type { PersonBrief } from '@rsn/shared';
import {
  KNOWN_SOURCES, MOVE_RESPONSE, SIGNAL, foundThrough, isClientError, isGone, isMemberId, knownSource, lastMetText,
  memoryRows, metTitle, moveToast, personFacts, reasonText, shouldRetry, statusOf, viewFor, whyNowRows,
  type LoadState, type Move,
} from '../../../../client/src/features/reason/human/profile-text';
import { BUSY } from '../../../../client/src/features/reason/human/busy';

type Person = PersonBrief['person'];
type Relationship = PersonBrief['relationship'];

const person = (over: Partial<Person> = {}): Person => ({
  id: '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03', displayName: 'Nora None', firstName: 'Nora', lastName: 'None', avatarUrl: null, bio: null,
  company: null, jobTitle: null, industry: null, location: null, linkedinUrl: null, languages: [], professionalRole: [],
  expertiseText: null, whatICanHelpWith: null, ...over,
});
const relationship = (over: Partial<Relationship> = {}): Relationship => ({
  state: 'none', pokeId: null, timesMet: 0, lastMetAt: null, saved: false, passed: false, outcomes: [], ...over,
});
const noShared = { circles: [], pods: [], upcomingEvents: [] };
// What axios hands a catch block when the server answered, and when nothing did.
const answered = (status: number) => ({ isAxiosError: true, response: { status, data: {} } });
const noAnswer = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });

const GENERIC_LINE = 'REASON explains why this person may matter to you right now.';

describe('?from= and the member id', () => {
  it('knows exactly the five places the app itself sends a member from', () => {
    expect([...KNOWN_SOURCES]).toEqual(['For You', 'People', 'Messages', 'Introductions', 'Your path']);
  });
  it('gives back a known source as it is', () => {
    for (const s of KNOWN_SOURCES) expect(knownSource(s)).toBe(s);
  });
  it('treats anything else as no source: other case, spaces, markup, another name, nothing', () => {
    for (const s of ['Profile', 'for you', 'FOR YOU', 'For You ', ' For You', 'Your Path', 'your path', '', 'Attacker Corp', '<img src=x onerror=alert(1)>', 'For You<b>', null]) {
      expect(knownSource(s)).toBeNull();
    }
  });
  it('accepts a member id in either case and nothing that is not one', () => {
    expect(isMemberId('3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03')).toBe(true);
    expect(isMemberId('3F2B8A4E-1C9D-4E7A-B6F0-2A5C8D1E9F03')).toBe(true);
    for (const s of [
      '', 'not-a-uuid', '../people/connections/recent?', '..%2Fpeople%2Fconnections%2Frecent%3F', '%2e%2e',
      '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03x', '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03/brief', ' 3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03',
      '3f2b8a4e1c9d4e7ab6f02a5c8d1e9f03', '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f0', 'zf2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03',
    ]) expect(isMemberId(s)).toBe(false);
  });
});

describe('what a failed request says about the person', () => {
  it('reads the status of an answer and nothing from anything else', () => {
    expect(statusOf(answered(404))).toBe(404);
    for (const e of [noAnswer, undefined, null, 'boom', {}, { response: undefined }, { response: {} }]) expect(statusOf(e)).toBeUndefined();
  });
  it('"gone" is a 404 (blocked, closed, unknown) or a 400 (a malformed id), and nothing else', () => {
    expect(isGone(answered(404))).toBe(true);
    expect(isGone(answered(400))).toBe(true);
    for (const e of [answered(401), answered(403), answered(409), answered(429), answered(500), answered(503), noAnswer, undefined, null]) {
      expect(isGone(e)).toBe(false);
    }
  });
  it('a client error is any 4xx, and no answer or a 5xx is not one', () => {
    for (const s of [400, 401, 403, 404, 409, 429, 499]) expect(isClientError(answered(s))).toBe(true);
    for (const e of [answered(500), answered(502), answered(399), noAnswer, undefined]) expect(isClientError(e)).toBe(false);
  });
  it('retries a lost connection and a 5xx once, and never a 4xx', () => {
    for (const e of [noAnswer, answered(500), answered(503)]) {
      expect(shouldRetry(0, e)).toBe(true);
      expect(shouldRetry(1, e)).toBe(false);
    }
    for (const s of [400, 401, 403, 404, 429]) expect(shouldRetry(0, answered(s))).toBe(false);
  });
});

describe('which screen the page shows (viewFor)', () => {
  const state = (over: Partial<LoadState> = {}): LoadState => ({
    hasBrief: false, validId: true, isPending: true, isError: false, error: null, fetchStatus: 'fetching', ...over,
  });
  it('shows the skeleton while the first answer is on its way', () => {
    expect(viewFor(state())).toBe('loading');
    // a query that has not started (waiting for the account) is also just waiting
    expect(viewFor(state({ fetchStatus: 'idle' }))).toBe('loading');
  });
  it('says it could not load when the library has PAUSED the request (the browser is offline), not a skeleton for ever', () => {
    expect(viewFor(state({ fetchStatus: 'paused' }))).toBe('failed');
  });
  it('shows the profile once there is a brief, including while a refetch is paused or has failed', () => {
    const shown = { hasBrief: true, isPending: false };
    expect(viewFor(state(shown))).toBe('profile');
    expect(viewFor(state({ ...shown, fetchStatus: 'paused' }))).toBe('profile');
    expect(viewFor(state({ ...shown, isError: true, error: noAnswer }))).toBe('profile');
    expect(viewFor(state({ ...shown, isError: true, error: answered(500) }))).toBe('profile');
    expect(viewFor(state({ ...shown, isError: true, error: answered(429) }))).toBe('profile');
  });
  it('says "not available" for a 404 or a 400, with or without a profile already on screen', () => {
    for (const status of [404, 400]) {
      expect(viewFor(state({ isPending: false, isError: true, error: answered(status) }))).toBe('unavailable');
      expect(viewFor(state({ hasBrief: true, isPending: false, isError: true, error: answered(status) }))).toBe('unavailable');
    }
  });
  it('says it could not load for a 5xx, a 429 and a lost connection that left nothing to show', () => {
    for (const error of [answered(500), answered(503), answered(429), answered(401), noAnswer]) {
      expect(viewFor(state({ isPending: false, isError: true, error }))).toBe('failed');
    }
  });
  it('says "not available" for an id that is not a member id, without waiting for anything', () => {
    expect(viewFor(state({ validId: false }))).toBe('unavailable');
    expect(viewFor(state({ validId: false, hasBrief: true, isPending: false }))).toBe('unavailable');
  });
});

describe('personFacts: who the page is about', () => {
  it('trims every text and joins the roles', () => {
    expect(personFacts(person({
      displayName: ' Nora None ', firstName: ' Nora ', company: ' Northwind Capital ', bio: ' Backs founders. ', jobTitle: 'Partner',
      industry: 'Fintech', professionalRole: ['Investor', ' Advisor ', '  ', ''],
    }))).toEqual({
      name: 'Nora None', first: 'Nora', role: 'Investor, Advisor', company: 'Northwind Capital', bio: 'Backs founders.',
      tags: ['Fintech', 'Investor', 'Advisor'],
    });
  });
  it('turns a blank text into nothing, so nothing blank is drawn', () => {
    expect(personFacts(person({ company: '   ', bio: '\n', jobTitle: ' ', industry: ' ', professionalRole: ['  ', ''] })))
      .toMatchObject({ role: null, company: null, bio: null, tags: [] });
    expect(personFacts(person({ company: null, bio: null, jobTitle: null, industry: null })))
      .toMatchObject({ role: null, company: null, bio: null, tags: [] });
  });
  it('uses the job title only when there is no role, and keeps at most four tags', () => {
    expect(personFacts(person({ jobTitle: 'Partner', professionalRole: [] })).role).toBe('Partner');
    expect(personFacts(person({ jobTitle: 'Partner', professionalRole: ['Investor'] })).role).toBe('Investor');
    expect(personFacts(person({ industry: 'Fintech', professionalRole: ['A', 'B', 'C', 'D', 'E'] })).tags).toEqual(['Fintech', 'A', 'B', 'C']);
  });
  it('calls a member with no name "Member", and takes the first word of the name when there is no first name', () => {
    for (const displayName of ['', '   ']) {
      expect(personFacts(person({ displayName, firstName: '' }))).toMatchObject({ name: 'Member', first: 'Member' });
    }
    expect(personFacts(person({ displayName: 'Ada Lovelace', firstName: '' }))).toMatchObject({ name: 'Ada Lovelace', first: 'Ada' });
    expect(personFacts(person({ displayName: 'Ada Lovelace', firstName: 'Augusta' })).first).toBe('Augusta');
  });
});

describe('reasonText: the dark panel', () => {
  const strong = { reason: "What you're looking for matches their profile: seed", strength: 'strong' as const };
  const FIRST = 'Start with what Nora can bring, and see whether there is a reason to meet.';
  const SECOND = 'See what you have in common, and whether there is a reason to meet.';
  it('prints the reason when there is a match', () => {
    expect(reasonText({ match: strong, theyCanBring: 'Seed introductions' }, 'Nora')).toBe(strong.reason);
    expect(reasonText({ match: strong, theyCanBring: null }, 'Nora')).toBe(strong.reason);
  });
  it('with no match and a public offer, claims neither that there is a reason nor that there is none', () => {
    expect(reasonText({ match: null, theyCanBring: 'Seed introductions' }, 'Nora')).toBe(FIRST);
  });
  it('with no match and no offer, says the second neutral sentence (a blank offer is no offer)', () => {
    expect(reasonText({ match: null, theyCanBring: null }, 'Nora')).toBe(SECOND);
    expect(reasonText({ match: null, theyCanBring: '   ' }, 'Nora')).toBe(SECOND);
  });
  it('treats a match with a blank reason as no match', () => {
    expect(reasonText({ match: { reason: '  ', strength: 'close' }, theyCanBring: 'Seed introductions' }, 'Nora')).toBe(FIRST);
    expect(reasonText({ match: { reason: '', strength: 'close' }, theyCanBring: null }, 'Nora')).toBe(SECOND);
  });
  it('never says REASON found no reason', () => {
    for (const bring of ['Seed introductions', null, ' ']) {
      expect(reasonText({ match: null, theyCanBring: bring }, 'Nora')).not.toMatch(/not found|no reason|clear reason/i);
    }
  });
  it('names the strengths', () => {
    expect(SIGNAL).toEqual({ strong: 'Strong reason', close: 'Worth exploring' });
  });
});

describe('foundThrough: the small box under the name', () => {
  it('says each known source in its own words', () => {
    expect(foundThrough('For You', 'Nora')).toEqual({
      title: 'You found Nora through For You',
      line: 'REASON surfaced Nora because this relationship looks unusually relevant to what you are trying to make happen now.',
    });
    expect(foundThrough('People', 'Nora')).toEqual({
      title: 'You found Nora through People',
      line: 'You found Nora while exploring the wider network. REASON still explains why this person may matter, rather than leaving you with a directory result.',
    });
    expect(foundThrough('Messages', 'Nora')).toEqual({
      title: 'You found Nora through Messages',
      line: 'This profile is the relationship layer behind your conversation. The history, reason and next useful move travel with the message thread.',
    });
    expect(foundThrough('Introductions', 'Nora')).toEqual({
      title: 'You found Nora through Introductions',
      line: 'This relationship arrived through an introduction. REASON keeps the introducer, reason and outcome as part of the relationship memory.',
    });
  });
  it('says "on your path", not "through Your path", for the one source that is a section of this page', () => {
    expect(foundThrough('Your path', 'Marta')).toEqual({ title: 'You found Marta on your path', line: GENERIC_LINE });
  });
  it('with no known source reads "About", and says the generic line', () => {
    expect(foundThrough(null, 'Nora')).toEqual({ title: 'About Nora', line: GENERIC_LINE });
  });
  it('never says "Profile", and always has something to say', () => {
    for (const s of [...KNOWN_SOURCES, null]) {
      const { title, line } = foundThrough(s, 'Nora');
      expect(title).toMatch(/^(You found Nora (through|on) |About Nora)/);
      expect(title).not.toMatch(/Profile/);
      expect(line.length).toBeGreaterThan(20);
    }
  });
});

describe('whyNowRows: "Why now"', () => {
  const strong = { reason: 'r', strength: 'strong' as const };
  const event = (title: string) => ({ id: 'e', title, scheduledAt: '2026-10-09T20:00:00.000Z' });
  it('has no row, and so the page says "Nothing time-bound yet.", with no match, no source and no shared event', () => {
    expect(whyNowRows({ match: null, shared: noShared }, null)).toEqual([]);
  });
  it('names the strength only when there is a match', () => {
    expect(whyNowRows({ match: strong, shared: noShared }, null)).toEqual([{ title: 'Strong reason', text: 'REASON believes this is currently relevant.' }]);
    expect(whyNowRows({ match: { reason: 'r', strength: 'close' }, shared: noShared }, null)[0].title).toBe('Worth exploring');
  });
  it('has a source row only for a known source', () => {
    expect(whyNowRows({ match: null, shared: noShared }, 'For You')).toEqual([{ title: 'For You', text: 'This is the context where you encountered each other.' }]);
    expect(whyNowRows({ match: null, shared: noShared }, 'Your path')[0].title).toBe('Your path');
  });
  it('has a row for the first shared event, and in this order: strength, source, event', () => {
    const shared = { circles: [], pods: [], upcomingEvents: [event('Demo Evening'), event('Later')] };
    expect(whyNowRows({ match: strong, shared }, 'People')).toEqual([
      { title: 'Strong reason', text: 'REASON believes this is currently relevant.' },
      { title: 'People', text: 'This is the context where you encountered each other.' },
      { title: 'Demo Evening', text: 'You will both be there.' },
    ]);
  });
});

describe('relationship memory', () => {
  it('says how many times you have met, in the words the end-to-end spec reads', () => {
    expect(metTitle(0)).toBe('You have not met yet.');
    expect(metTitle(1)).toBe('You have met 1 time.');
    expect(metTitle(2)).toBe('You have met 2 times.');
    expect(metTitle(12)).toBe('You have met 12 times.');
  });
  it('gives the date of the last meeting, and does not say "no meeting recorded" for a meeting that has no date', () => {
    expect(lastMetText({ lastMetAt: '2026-10-04T12:00:00.000Z', timesMet: 2 })).toMatch(/^Last met .+2026\.$/);
    expect(lastMetText({ lastMetAt: null, timesMet: 1 })).toBe('The date of your last meeting is not recorded.');
    expect(lastMetText({ lastMetAt: null, timesMet: 0 })).toBe('No meeting recorded yet.');
  });
  it('starts with where the relationship stands, then the newest outcome', () => {
    const rows = memoryRows(relationship({
      state: 'met', timesMet: 2, lastMetAt: '2026-10-04T12:00:00.000Z',
      outcomes: [
        { worthContinuing: 'yes', outcomes: ['introduction', 'follow_up'], createdAt: '2026-10-06T10:00:00.000Z' },
        { worthContinuing: 'maybe', outcomes: ['advice'], createdAt: '2026-10-05T10:00:00.000Z' },
      ],
    }));
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Met');
    expect(rows[0].text).toMatch(/^Last met /);
    expect(rows[1]).toEqual({ title: 'Worth continuing', text: 'Introduction, Follow up' });
  });
  it('names the three answers, and says "Nothing noted." when none was ticked', () => {
    const one = (worthContinuing: 'yes' | 'maybe' | 'no', outcomes: Relationship['outcomes'][number]['outcomes']) =>
      memoryRows(relationship({ state: 'connected', outcomes: [{ worthContinuing, outcomes, createdAt: '2026-10-06T10:00:00.000Z' }] }))[1];
    expect(one('yes', ['hiring']).title).toBe('Worth continuing');
    expect(one('maybe', ['hiring']).title).toBe('Maybe worth continuing');
    expect(one('no', ['hiring']).title).toBe('Not worth continuing');
    expect(one('maybe', [])).toEqual({ title: 'Maybe worth continuing', text: 'Nothing noted.' });
  });
  it('has only the state row before anything was recorded, and a title for every state', () => {
    expect(memoryRows(relationship({ state: 'none' }))).toEqual([{ title: 'New relationship', text: 'No meeting recorded yet.' }]);
    expect(memoryRows(relationship({ state: 'declined' }))[0].title).toBe('Request declined');
    expect(memoryRows(relationship({ state: 'incoming' }))[0].title).toBe('They asked to meet you');
  });
});

describe('moveToast: every Save and Pass press answers', () => {
  it('says the four sentences, with the name', () => {
    expect(moveToast('save', 'Nora')).toEqual({ message: 'Nora saved', type: 'success' });
    expect(moveToast('unsave', 'Nora')).toEqual({ message: 'Nora removed from saved', type: 'success' });
    expect(moveToast('pass', 'Nora')).toEqual({ message: 'Nora will not be suggested in For You. You can undo this here.', type: 'info' });
    expect(moveToast('unpass', 'Nora')).toEqual({ message: 'Nora can be suggested in For You again.', type: 'info' });
  });
  it('sends one request per move, and clearing is the same request for both ways of clearing', () => {
    expect(MOVE_RESPONSE).toEqual({ save: 'saved', unsave: null, pass: 'passed', unpass: null });
    const clears: Move[] = ['unsave', 'unpass'];
    expect(new Set(clears.map((m) => moveToast(m, 'Nora').message)).size).toBe(2);
  });
});

describe('the busy look', () => {
  it('is a progress cursor, a pulse, and a still dim for reduced motion', () => {
    expect(BUSY).toBe('cursor-progress motion-safe:animate-pulse motion-reduce:opacity-60');
  });
  it('is the look the Human Card uses: it imports this module and keeps no copy of the string', () => {
    const card = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/reason/human/HumanCard.tsx'), 'utf8');
    expect(card).toMatch(/from '\.\/busy'/);
    expect(card).not.toContain(BUSY);
  });
});
