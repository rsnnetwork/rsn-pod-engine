// server/src/__tests__/client/reason-m1-profile.test.ts
// The Human Profile's rules that an edit could quietly undo (REASON milestone 1, Task B6).
// Like the other client tests here it reads the source: the page needs a router, a store and a
// browser to run, and the look at the real page covers that side.
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '../../../../client/src/features/reason/human');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('HumanProfilePage.tsx');
const hero = () => read('ProfileHero.tsx');
const details = () => read('ProfileDetails.tsx');
const bar = () => read('MoveBar.tsx');
const all = () => [page(), hero(), details(), bar()];
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;

describe('Human Profile: ?from= is not free text', () => {
  it('accepts only the five places the app itself sends a member from', () => {
    const list = page().match(/KNOWN_SOURCES = \[([^\]]*)\]/)?.[1] ?? '';
    expect([...list.matchAll(/'([^']*)'/g)].map((m) => m[1]))
      .toEqual(['For You', 'People', 'Messages', 'Introductions', 'Your path']);
  });
  it('looks the value up in that list, and never prints it as it arrives', () => {
    expect(page()).toMatch(/KNOWN_SOURCES\.find\(/);
    expect(page()).not.toMatch(/get\('from'\)\s*\|\|/);
    expect(page()).not.toMatch(/\.slice\(0, 40\)/);
  });
  it('with no known source the hero says "About", and the timeline has no source row', () => {
    expect(hero()).toMatch(/You found \$\{[^}]*first\} through \$\{source\}/);
    expect(hero()).toMatch(/`About \$\{[^}]*first\}`/);
    expect(hero()).toMatch(/REASON explains why this person may matter to you right now\./);
    expect(hero()).not.toMatch(/through Profile/);
    expect(details()).toMatch(/\.\.\.\(source \? \[\{ title: source/);
    expect(details()).toMatch(/Nothing time-bound yet\./);
  });
});

describe('Human Profile: two different failures', () => {
  it('"not available" is said once, and only for a 404 or a 400', () => {
    expect(count(page(), /This profile is not available\./g)).toBe(1);
    expect(page()).toMatch(/GONE_STATUSES = \[404, 400\]/);
    expect(page()).toMatch(/GONE_STATUSES\.includes\(/);
    expect(page()).toMatch(/const gone = isError && isGone\(error\)/);
  });
  it('anything else says the profile could not be loaded, and offers Try again that refetches', () => {
    expect(page()).toMatch(/We could not load this profile just now\./);
    expect(page()).toMatch(/Try again/);
    expect(page()).toMatch(/onClick=\{\(\) => void refetch\(\)\}/);
  });
  it('a 4xx is never retried; a dropped connection or a 5xx is retried once', () => {
    expect(page()).toMatch(/retry: \(failures, err\) => !isClientError\(err\) && failures < 1/);
    expect(page()).toMatch(/status >= 400 && status < 500/);
    expect(page()).not.toMatch(/retry: (false|\d)/);
  });
  it('"still loading" is isPending, and a refetch that fails keeps the profile on screen', () => {
    expect(page()).toMatch(/\bisPending\b/);
    expect(page()).not.toMatch(/\bisLoading\b/);
    // Only the answer "this person is gone" replaces a profile that is already showing.
    expect(page()).toMatch(/const shown = gone \? undefined : brief/);
  });
});

describe('Human Profile: the reason panel stays neutral without a match', () => {
  it('never says REASON found no reason, and uses the two approved sentences', () => {
    for (const src of all()) expect(src).not.toMatch(/has not found a clear reason/);
    expect(hero()).toMatch(/Start with what \$\{[^}]*first\} can bring, and see whether there is a reason to meet\./);
    expect(hero()).toMatch(/See what you have in common, and whether there is a reason to meet\./);
  });
  it('the strength badge and the "Why now" strength row exist only with a match', () => {
    expect(hero()).toMatch(/brief\.match && \(/);
    expect(details()).toMatch(/\.\.\.\(brief\.match \? \[\{ title: /);
  });
});

describe('Human Profile: the way back stays in the app', () => {
  it('goes by the router, not by the length of the browser history', () => {
    expect(page()).toMatch(/useLocation\(\)/);
    expect(page()).toMatch(/location\.key === 'default'/);
    expect(page()).toMatch(/navigate\('\/', \{ replace: true \}\)/);
    expect(page()).toMatch(/navigate\(-1\)/);
    expect(page()).not.toMatch(/history\.length/);
  });
});

describe('Human Profile: one brief query, tagged for realtime', () => {
  it('has the four entity tags', () => {
    expect(page()).toMatch(/entities: me && userId \? \[E\.user\(me\), E\.user\(userId\), E\.userInvites\(me\), E\.userDms\(me\)\] : \[\]/);
  });
  it('asks for the brief once, in the page: no second copy in a child, no polling', () => {
    expect(count(page(), /\buseQuery\(/g)).toBe(1);
    expect(count(page(), /fetchBrief\(/g)).toBe(1);
    for (const src of [hero(), details(), bar()]) expect(src).not.toMatch(/useQuery|fetchBrief|reasonKeys|refetchInterval/);
    for (const src of all()) expect(src).not.toMatch(/setInterval|refetchInterval/);
  });
});

describe('Human Profile: every Save and Pass press answers', () => {
  it('has a sentence for each of the four moves, and uses errorMessage for a failure', () => {
    expect(page()).toMatch(/\$\{name\} saved/);
    expect(page()).toMatch(/\$\{name\} removed from saved/);
    expect(page()).toMatch(/\$\{name\} will not be suggested in For You\. You can undo this here\./);
    expect(page()).toMatch(/\$\{name\} can be suggested in For You again\./);
    expect(page()).toMatch(/errorMessage\(err, /);
  });
  it('names a member who has no name, and drops a blank field instead of drawing it', () => {
    expect(hero()).toMatch(/personName\(/);
    expect(hero()).toMatch(/visibleText\(p\.company\)/);
    expect(hero()).toMatch(/visibleText\(p\.bio\)/);
  });
});

describe('Human Profile: what the end-to-end spec looks for', () => {
  it('the name is the only h1 of a state; the other parts never add one', () => {
    expect(count(hero(), /<h1\b/g)).toBe(1);
    expect(count(page(), /<h1\b/g)).toBe(1);
    expect(details()).not.toMatch(/<h1\b/);
    expect(bar()).not.toMatch(/<h1\b/);
  });
  it('keeps the button names and the sentences it presses and reads', () => {
    expect(page()).toMatch(/← Back/);
    expect(bar()).toMatch(/'Pass: not relevant right now'/);
    expect(bar()).toMatch(/'Undo pass'/);
    expect(bar()).toMatch(/'Remove from saved'/);
    expect(bar()).toMatch(/: 'Save'/);
    expect(details()).toMatch(/Record what happened/);
    expect(details()).toMatch(/You have met \$\{r\.timesMet\} time\$\{r\.timesMet === 1 \? '' : 's'\}\./);
    for (const label of ['Worth continuing', 'Maybe worth continuing', 'Not worth continuing']) expect(details()).toContain(`'${label}'`);
  });
});

// Each of these was found by opening the page (Chromium and WebKit, 360 to 1920 wide), not by reading it.
describe('Human Profile: faults found by looking at it', () => {
  it('a quick second tap on Save or Pass is ignored until the first one settles (the button is disabled a moment late)', () => {
    expect(page()).toMatch(/const pressing = useRef\(false\)/);
    expect(page()).toMatch(/if \(pressing\.current\) return;/);
    expect(page()).toMatch(/onSettled: \(\) => \{ pressing\.current = false; \}/);
    expect(page()).toMatch(/onToggleSave=\{\(\) => press\(/);
    expect(page()).toMatch(/onTogglePass=\{\(\) => press\(/);
  });
  it('after Save or Pass it invalidates the brief itself (the page must update with the socket down), never writes the cache', () => {
    expect(page()).toMatch(/qc\.invalidateQueries\(\{ queryKey: reasonKeys\.all \}\)/);
    expect(page()).not.toMatch(/setQueryData/);
  });
  it('a profile opened from another one starts at its top, with an instant jump (the app scrolls smoothly)', () => {
    expect(page()).toMatch(/useLayoutEffect\(\(\) => \{\s*window\.scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\);\s*\}, \[\]\)/);
  });
  it('the three columns are slimmer from 981px to 1199px, so a name is not cut mid-word at 1024px', () => {
    expect(hero()).toMatch(/min-\[981px\]:grid-cols-\[250px_minmax\(0,1fr\)_290px\] min-\[1200px\]:grid-cols-\[320px_minmax\(0,1fr\)_330px\]/);
    expect(hero()).not.toMatch(/min-\[981px\]:grid-cols-\[320px/);
  });
  it('a meeting with no date does not say "no meeting recorded" under "You have met 1 time"', () => {
    expect(details()).toMatch(/r\.timesMet > 0 \? 'The date of your last meeting is not recorded\.' : 'No meeting recorded yet\.'/);
  });
  it('a failed photo and no photo look alike: the photo covers the tile, initials sit round in the middle', () => {
    expect(hero()).toMatch(/\[&>img\]:absolute \[&>img\]:inset-0 \[&>img\]:h-full \[&>img\]:w-full \[&>img\]:rounded-none/);
    expect(count(hero(), /<Avatar\b/g)).toBe(1);
  });
  it('a link or button in the page keeps clear of the header and the bar when the keyboard focuses it', () => {
    expect(details()).toMatch(/const KEEP_CLEAR = 'scroll-mt-\[calc\(90px\+env\(safe-area-inset-top\)\)\] scroll-mb-\[calc\(100px\+env\(safe-area-inset-bottom\)\)\]'/);
    // The definition, the shared-context chips, the path link and the Record button.
    expect(count(details(), /KEEP_CLEAR/g)).toBe(4);
  });
  it('the fixed header and bar grow by the notch and the home indicator, and keep their sides clear of a phone on its side', () => {
    expect(page()).toMatch(/h-\[calc\(60px\+env\(safe-area-inset-top\)\)\]/);
    expect(page()).toMatch(/md:h-\[calc\(70px\+env\(safe-area-inset-top\)\)\]/);
    expect(page()).toMatch(/pl-\[max\(11px,env\(safe-area-inset-left\)\)\] pr-\[max\(11px,env\(safe-area-inset-right\)\)\]/);
    expect(bar()).toMatch(/pl-\[env\(safe-area-inset-left\)\] pr-\[env\(safe-area-inset-right\)\]/);
    expect(bar()).toMatch(/md:pb-\[calc\(12px\+env\(safe-area-inset-bottom\)\)\]/);
    expect(page()).toMatch(/pl-\[max\(12px,env\(safe-area-inset-left\)\)\] pr-\[max\(12px,env\(safe-area-inset-right\)\)\]/);
  });
});

describe('Human Profile: small text and phones', () => {
  it('uses none of the greys that fail 4.5:1, and no red text', () => {
    for (const src of all()) {
      expect(src).not.toMatch(/#7b8190|#8b8f96/i);
      expect(src).not.toMatch(/(?<![\w-])text-reason-red(?!-hover)/);
    }
  });
  it('says "event", never "session" (the /sessions/ address is not text)', () => {
    for (const src of all()) expect(src.replace(/\/sessions\/\$\{[^}]*\}/g, '')).not.toMatch(/\bsessions?\b/i);
  });
  it('the bar clears the home indicator, its buttons are 48px, and the page clears the bar', () => {
    expect(bar()).toMatch(/env\(safe-area-inset-bottom\)/);
    // The main button, and the class (or the two copies of it) that Save and Pass use.
    expect(count(bar(), /min-h-\[48px\]/g)).toBeGreaterThanOrEqual(2);
    expect(page()).toMatch(/pb-\[calc\(116px\+env\(safe-area-inset-bottom\)\)\]/);
    expect(page()).toMatch(/env\(safe-area-inset-top\)/);
  });
});
