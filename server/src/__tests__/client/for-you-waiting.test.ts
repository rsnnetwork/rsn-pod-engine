// server/src/__tests__/client/for-you-waiting.test.ts
// For You, 22 Nov 2026 (Stefan: "Why are these 5 people suggested to me?"). People the member already asked leave the
// suggestions for a "Waiting for their answer" row; a card that was just asked says "Request sent" until the list is
// fetched again; a broad ask gets a line suggesting to narrow it; Matches lists every waiting request with Withdraw.
// The pure rules are executed; the wiring is read as source, as the other client tests here do.
import * as fs from 'fs';
import * as path from 'path';
import { WAITING_SHOWN, askedSinceFetch, meetRequestUserId, waitingRow } from '../../../../client/src/features/reason/for-you/for-you-view';
import type { WaitingRequest } from '../../../../client/src/features/reason/api';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
const withoutComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const page = () => read('features/reason/for-you/ForYouPage.tsx');
const waitingSrc = () => read('features/reason/for-you/ForYouWaiting.tsx');
const matches = () => read('features/matches/MatchesPage.tsx');

const person = (i: number): WaitingRequest => ({
  userId: `u-${i}`, displayName: `Person ${i}`, avatarUrl: null, professionalRole: 'Founder', company: null, sentAt: '2026-11-17T09:00:00Z',
});

describe('the waiting row: the first six, then "and n more"', () => {
  it('shows at most six and counts the rest from the full count, which can be more than the list sent', () => {
    const list = Array.from({ length: 40 }, (_, i) => person(i));
    expect(WAITING_SHOWN).toBe(6);
    const row = waitingRow(list.slice(0, 37), 37);
    expect(row.shown.map((w) => w.userId)).toEqual(['u-0', 'u-1', 'u-2', 'u-3', 'u-4', 'u-5']);
    expect(row.more).toBe(31);
    expect(waitingRow(list.slice(0, 100), 140).more).toBe(134);
  });

  it('four waiting: all four, nothing more; none, or an older server that sends nothing: an empty row', () => {
    expect(waitingRow([person(1), person(2), person(3), person(4)], 4)).toEqual({ shown: [person(1), person(2), person(3), person(4)], more: 0 });
    expect(waitingRow([], 0)).toEqual({ shown: [], more: 0 });
    expect(waitingRow(undefined, undefined)).toEqual({ shown: [], more: 0 });
  });

  it('is drawn only when someone is waiting, says how many, links each to their profile and the rest to Matches', () => {
    const src = withoutComments(waitingSrc());
    expect(src).toContain('if (shown.length === 0) return null;');
    expect(src).toContain('Waiting for their answer ({total})');
    expect(src).toContain("to={personHref(w.userId, 'For You')}");
    expect(src).toContain("export const ALL_WAITING_TO = '/matches#waiting';");
    expect(src).toMatch(/<Link to=\{ALL_WAITING_TO\} aria-label=\{`See all \$\{total\} people waiting for their answer`\}[^>]*min-h-\[44px\][^>]*>\s*and \{more\} more\s*<\/Link>/);
    expect(src).toContain('<ProfileBadge badge={w.profileBadge} />');
    // Every row is a 44px target.
    expect(src).toMatch(/<Link to=\{personHref[^>]*className="[^"]*min-h-\[44px\]/);
  });

  it('sits under the suggestions inside the For You section, and under the empty state too', () => {
    const src = withoutComments(page());
    const section = src.slice(src.indexOf('<section'), src.indexOf('</section>'));
    expect(section).toContain('<ForYouWaiting waiting={data?.waiting} waitingCount={data?.waitingCount} />');
    expect(section.indexOf('<ForYouWaiting')).toBeGreaterThan(section.indexOf('When someone wants to meet you too'));
    expect(section.indexOf('<ForYouWaiting')).toBeGreaterThan(section.indexOf('<ForYouEmpty'));
  });
});

describe('a card just asked says "Request sent" until the list moves the person', () => {
  it('a Meet sheet request is told apart by what it carries', () => {
    expect(meetRequestUserId({ userId: 'u-1', displayName: 'A', note: 'Hi', format: 'video_20' })).toBe('u-1');
    // A Save (a HumanCardPerson), a withdraw (no variables) and anything else are not.
    expect(meetRequestUserId({ userId: 'u-1', displayName: 'A', saved: false })).toBeNull();
    expect(meetRequestUserId(undefined)).toBeNull();
    expect(meetRequestUserId('u-1')).toBeNull();
  });

  it('...whose shape is still the Meet sheet\'s', () => {
    expect(read('features/reason/human/MeetSheet.tsx')).toContain('interface MeetRequest { userId: string; displayName: string; note: string; format: MeetingFormat }');
  });

  it('only requests sent after the list on screen was fetched count: once it is fetched again the server decides', () => {
    const asked = [{ userId: 'u-1', submittedAt: 2000 }, { userId: 'u-2', submittedAt: 500 }, { userId: null, submittedAt: 3000 }];
    expect([...askedSinceFetch(asked, 1000)]).toEqual(['u-1']);
    expect([...askedSinceFetch(asked, 2500)]).toEqual([]);
  });

  it('the page reads succeeded Meet sheet requests, and only turns a card that offers Meet into "Request sent"', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/const \{ data, dataUpdatedAt, [^}]*\} = useQuery\(/);
    expect(src).toMatch(/filters: \{ status: 'success', predicate: \(m\) => meetRequestUserId\(m\.state\.variables\) !== null \}/);
    expect(src).toContain('const askedNow = askedSinceFetch(asked, dataUpdatedAt);');
    expect(src).toContain("state: asked && state === 'none' ? 'requested' : state,");
    expect(src).toContain('toCard(m, data?.youAreLookingFor ?? null, askedNow.has(m.userId))');
    // The badge the server sends reaches the card.
    expect(src).toContain('profileBadge: m.profileBadge ?? null,');
  });
});

describe('a broad ask is told so, with the way to narrow it', () => {
  it('a line under the suggestions, linking to the question about who they want to meet, 44px', () => {
    const src = withoutComments(page());
    expect(src).toContain("const EDIT_WANTS_TO = '/onboarding?edit=q1';");
    expect(src).toContain('{data?.wantsBroad && !data.profileIncomplete && (');
    expect(src).toContain('You are looking for many kinds of people, so these suggestions are broad. Narrow who you want to meet for closer ones.');
    expect(src).toMatch(/<Link to=\{EDIT_WANTS_TO\} className="[^"]*min-h-\[44px\][^"]*">Edit who I want to meet<\/Link>/);
  });

  it('the empty state says the member has asked everyone who fits when requests are waiting', () => {
    const src = page();
    expect(src).toContain('const someWaiting = (data?.waitingCount ?? data?.waiting?.length ?? 0) > 0;');
    const empty = read('features/reason/for-you/ForYouEmpty.tsx');
    expect(empty).toContain("const ALL_ASKED_TEXT = 'The people you asked are below. New people who fit what you are looking for will show up here.';");
  });
});

describe('Matches lists every waiting request, with Withdraw', () => {
  it('a section at #waiting: each person links to their profile, says Request sent and offers Withdraw', () => {
    const src = withoutComments(matches());
    expect(src).toMatch(/<section id="waiting" aria-labelledby="waiting-title"/);
    expect(src).toContain('Waiting for their answer ({waitingCount})');
    expect(src).toContain('to={`/people/${w.userId}?from=People`}');
    expect(src).toContain('<WithdrawRequestButton userId={w.userId} />');
    expect(src).toMatch(/<Check className="h-4 w-4" \/> Request sent/);
  });

  it('scrolls to the section once the answer is in when For You\'s "and n more" opened it', () => {
    const src = withoutComments(matches());
    expect(src).toContain("if (hasData && window.location.hash === '#waiting') document.getElementById('waiting')?.scrollIntoView({ block: 'start' });");
    // A hook before the early return, so the hooks are the same on every render.
    expect(src.indexOf('useEffect(')).toBeLessThan(src.indexOf('if (isLoading) return <PageLoader />;'));
  });

  it('says "event", never "session", in the new words', () => {
    for (const src of [waitingSrc(), matches().slice(matches().indexOf('<section id="waiting"'))]) {
      expect(withoutComments(src).replace(/^import\b[^;]*;$/gm, '').replace(/(['"`])\/[^'"`]*\1/g, '')).not.toMatch(/session/i);
    }
  });
});
