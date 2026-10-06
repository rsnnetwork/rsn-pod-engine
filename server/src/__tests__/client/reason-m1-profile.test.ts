// server/src/__tests__/client/reason-m1-profile.test.ts
// The Human Profile's markup and wiring that an edit could quietly undo (REASON milestone 1, Task B6). Like the
// other client tests here it reads the source: the page needs a router, a store and a browser to run. What the
// page SAYS, and the rules behind it, live in profile-text.ts and are executed in reason-m1-profile-text.test.ts.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

const dir = path.join(__dirname, '../../../../client/src/features/reason/human');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('HumanProfilePage.tsx');
const hero = () => read('ProfileHero.tsx');
const details = () => read('ProfileDetails.tsx');
const bar = () => read('MoveBar.tsx');
const rules = () => read('profile-text.ts');
const components = () => [page(), hero(), details(), bar()];
const everything = () => [...components(), rules(), read('busy.ts')];
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;

describe('Human Profile: one brief query, tagged for realtime', () => {
  it('has the four entity tags', () => {
    expect(page()).toMatch(/entities: me && userId \? \[E\.user\(me\), E\.user\(userId\), E\.userInvites\(me\), E\.userDms\(me\)\] : \[\]/);
  });
  it('asks for the brief once, in the page: no second copy in a child, no polling', () => {
    expect(count(page(), /\buseQuery\(/g)).toBe(1);
    expect(count(page(), /fetchBrief\(/g)).toBe(1);
    for (const src of [hero(), details(), bar()]) expect(src).not.toMatch(/useQuery|fetchBrief|reasonKeys|refetchInterval/);
    for (const src of everything()) expect(src).not.toMatch(/setInterval|refetchInterval/);
  });
  it('asks only for a member id that is not your own, in the one spelling the server uses', () => {
    expect(page()).toMatch(/const userId = param\.toLowerCase\(\)/);
    expect(page()).toMatch(/const validId = isMemberId\(userId\)/);
    expect(page()).toMatch(/enabled: validId && !!me && userId !== me/);
  });
  it('retries by the shared rule (a lost connection or a 5xx once, a 4xx never)', () => {
    expect(page()).toMatch(/retry: shouldRetry,/);
    expect(page()).not.toMatch(/retry: (false|\d)/);
  });
});

describe('Human Profile: ?from= is not free text', () => {
  it('looks the value up in the shared list, and never prints it as it arrives', () => {
    expect(page()).toMatch(/knownSource\(params\.get\('from'\)\)/);
    expect(page()).not.toMatch(/get\('from'\)\s*\|\|/);
    expect(page()).not.toMatch(/\.slice\(0, 40\)/);
  });
});

describe('Human Profile: the network is down', () => {
  it('a Save or Pass fails at once offline: its request is not parked until the connection returns', () => {
    expect(page()).toMatch(/useMutation\(\{\s*networkMode: 'always',/);
  });
  it('the page chooses its screen from the query state, fetch status included, so a paused request is a failure and not a skeleton', () => {
    expect(page()).toMatch(/viewFor\(\{/);
    expect(page()).toMatch(/fetchStatus,/);
    expect(page()).not.toMatch(/\bisLoading\b/);
  });
  it('the line under "could not load" comes from the failure itself, and none says "check your connection" whatever happened', () => {
    expect(page()).toMatch(/errorMessage\(error, /);
    expect(page()).not.toMatch(/Check your connection, then try again/);
  });
  it('the notice draws the sheep only when the server answered, so a lost connection leaves no broken-image box', () => {
    expect(page()).toMatch(/function Notice\(\{ title, text, sheep = true, children \}/);
    expect(page()).toMatch(/\{sheep && <ReasonSheep pose="thinking"/);
    expect(page()).toMatch(/sheep=\{statusOf\(error\) !== undefined\}/);
  });
  it('"not available" and "could not load" are each said once, and Try again refetches', () => {
    expect(count(page(), /This profile is not available\./g)).toBe(1);
    expect(count(page(), /We could not load this profile just now\./g)).toBe(1);
    expect(page()).toMatch(/onClick=\{\(\) => void refetch\(\)\}/);
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

describe('Human Profile: Save and Pass', () => {
  it('a quick second tap is ignored until the first one has finished', () => {
    expect(page()).toMatch(/const pressing = useRef\(false\)/);
    expect(page()).toMatch(/if \(pressing\.current\) return;/);
    expect(page()).toMatch(/onSettled: \(\) => \{ pressing\.current = false; \}/);
    expect(page()).toMatch(/onToggleSave=\{\(\) => press\(/);
    expect(page()).toMatch(/onTogglePass=\{\(\) => press\(/);
  });
  it('the buttons stay busy until the fresh brief is in: the refresh is returned, so the press is not done before the star changes', () => {
    expect(page()).toMatch(/return qc\.invalidateQueries\(\{ queryKey: reasonKeys\.all \}\)/);
    expect(page()).not.toMatch(/setQueryData/);
  });
  it('a 404 on a press refreshes the brief, so the page changes to "not available" instead of leaving live buttons on a gone person', () => {
    expect(page()).toMatch(/statusOf\(err\) === 404/);
    expect(page()).toMatch(/qc\.invalidateQueries\(\{ queryKey: reasonKeys\.brief\(userId\) \}\)/);
  });
  it('the sheets get the same person object until it really changes, so a refetch cannot reset a note being typed', () => {
    expect(page()).toMatch(/const meetPerson = useMemo\(\(\) => \(meetOpen \? \{ userId, displayName: who\.name \} : null\), \[meetOpen, userId, who\.name\]\)/);
    expect(page()).toMatch(/const outcomePerson = useMemo\(\(\) => \(outcomeOpen \? \{ userId, displayName: who\.name \} : null\), \[outcomeOpen, userId, who\.name\]\)/);
    expect(page()).toMatch(/<MeetSheet person=\{meetPerson\}/);
    expect(page()).toMatch(/<OutcomeSheet person=\{outcomePerson\}/);
  });
  it('the buttons are named for the state they offer, and carry no pressed state (a name that flips AND a pressed flag is read twice)', () => {
    expect(bar()).toMatch(/'Pass: not relevant right now'/);
    expect(bar()).toMatch(/'Undo pass'/);
    expect(bar()).toMatch(/'Remove from saved'/);
    expect(bar()).toMatch(/: 'Save'/);
    expect(bar()).not.toMatch(/aria-pressed/);
  });
  it('while busy the buttons say aria-disabled, show the busy look and ignore presses, but never become disabled (that drops the keyboard focus)', () => {
    expect(count(bar(), /aria-disabled=\{busy \|\| undefined\}/g)).toBe(3);
    expect(bar()).not.toMatch(/(?<![-\w])disabled=\{[^}]*busy/);
    // Only the inert states of the main button are really disabled.
    expect(count(bar(), /(?<![-\w])disabled=\{/g)).toBe(1);
    expect(bar()).toMatch(/(?<![-\w])disabled=\{inert\}/);
    expect(bar()).toMatch(/if \(!busy\) fn\(\);/);
  });
  it('uses the shared busy look, not a copy of it', () => {
    expect(bar()).toMatch(/import \{ BUSY \} from '\.\/busy';/);
    expect(bar()).not.toMatch(/const BUSY\b/);
  });
  // The round-1 review asked for this pin and the rewrite of this file dropped it.
  it('a failed Save or Pass says why through errorMessage, never the server\'s own words or an error object', () => {
    expect(page()).toMatch(/onError: \(err\) => \{\s*addToast\(errorMessage\(err, '[^']+'\), 'error'\);/);
    expect(page()).not.toMatch(/addToast\((err|error)\b|err\.message|err\.response/);
  });
});

// Two more that the round-1 review asked for and the rewrite dropped. What the page prints when there is nothing
// to show is pinned here; the rules that decide when there is nothing are executed in reason-m1-profile-text.test.ts.
describe('Human Profile: a section with nothing to show says so, or leaves its badge out', () => {
  it('"Why now" prints "Nothing time-bound yet." when its timeline would be empty, and the timeline only when it has a row', () => {
    expect(details()).toMatch(/\{whyNow\.length > 0 \? <Timeline items=\{whyNow\} \/> : <p className=\{BODY\}>Nothing time-bound yet\.<\/p>\}/);
    expect(count(details(), /Nothing time-bound yet\./g)).toBe(1);
  });
  it('the strength badge on the photo is drawn only when the brief has a match', () => {
    expect(hero()).toMatch(/\{brief\.match && \(\s*<span[^>]*>[\s\S]*?\{SIGNAL\[brief\.match\.strength\]\}\s*<\/span>\s*\)\}/);
    expect(count(hero(), /SIGNAL\[/g)).toBe(1);
  });
});

describe('Human Profile: landmarks and headings', () => {
  it('the name is the only h1 of a state; the other parts never add one', () => {
    expect(count(hero(), /<h1\b/g)).toBe(1);
    expect(count(page(), /<h1\b/g)).toBe(1);
    expect(details()).not.toMatch(/<h1\b/);
    expect(bar()).not.toMatch(/<h1\b/);
  });
  it('the section titles are h2, level with the dark panel, with no heading level skipped', () => {
    expect(count(details(), /<h2\b/g)).toBe(1);
    for (const src of components()) expect(src).not.toMatch(/<h[3-6]\b/);
  });
  it('the bar is a region called "Your move", not the page footer', () => {
    expect(bar()).toMatch(/role="region"/);
    expect(bar()).toMatch(/aria-label="Your move"/);
    expect(bar()).not.toMatch(/<footer\b/);
  });
});

describe('Human Profile: the rules live in one module with no React, and the components only draw', () => {
  it('no component defines one of the rules', () => {
    const defined = /\b(function|const) (personFacts|reasonText|foundThrough|whyNowRows|metTitle|lastMetText|memoryRows|moveToast|viewFor|knownSource|isMemberId|statusOf|isGone|isClientError|shouldRetry|KNOWN_SOURCES|SIGNAL|WORTH_LABEL|MOVE_RESPONSE)\b/;
    for (const src of components()) expect(src).not.toMatch(defined);
  });
  it('the page, the hero and the details take them from profile-text, and the details no longer reach into the hero', () => {
    for (const src of [page(), hero(), details()]) expect(src).toMatch(/from '\.\/profile-text';/);
    expect(details()).not.toMatch(/from '\.\/ProfileHero'/);
  });
  it('imports only pure modules: shared types and values, person.ts and labels.ts', () => {
    const sources = new Set([...rules().matchAll(/from '([^']+)'/g)].map((m) => m[1]));
    expect([...sources].sort()).toEqual(['../person', './labels', '@rsn/shared']);
    expect(read('busy.ts')).not.toMatch(/\bimport\b/);
  });
});

// Each of these was found by opening the page (Chromium and WebKit, 320 to 1999 wide), not by reading it.
describe('Human Profile: faults found by looking at it', () => {
  it('a profile opened from another one starts at its top, with an instant jump (the app scrolls smoothly)', () => {
    expect(page()).toMatch(/useLayoutEffect\(\(\) => \{\s*window\.scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\);\s*\}, \[\]\)/);
  });
  it('the three columns are slimmer from 981px to 1199px and the name smaller, so no name is cut mid-word at 1024px', () => {
    expect(hero()).toMatch(/min-\[981px\]:grid-cols-\[250px_minmax\(0,1fr\)_290px\] min-\[1200px\]:grid-cols-\[320px_minmax\(0,1fr\)_330px\]/);
    expect(hero()).not.toMatch(/min-\[981px\]:grid-cols-\[320px/);
    expect(hero()).toMatch(/<h1 className="[^"]*min-\[981px\]:max-\[1199px\]:text-\[44px\]/);
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
    for (const src of everything()) {
      expect(src).not.toMatch(/#7b8190|#8b8f96/i);
      expect(src).not.toMatch(/(?<![\w-])text-reason-red(?!-hover)/);
    }
  });
  it('says "event", never "session" (the /sessions/ address is not text)', () => {
    for (const src of everything()) expect(src.replace(/\/sessions\/\$\{[^}]*\}/g, '')).not.toMatch(/\bsessions?\b/i);
  });
  it('never says REASON found no reason, anywhere in the page, its parts or its words', () => {
    for (const src of everything()) expect(src).not.toMatch(/has not found a clear reason/);
  });
  it('the bar clears the home indicator, its buttons are 48px, and the page clears the bar', () => {
    expect(bar()).toMatch(/env\(safe-area-inset-bottom\)/);
    // The main button, and the class (or the two copies of it) that Save and Pass use.
    expect(count(bar(), /min-h-\[48px\]/g)).toBeGreaterThanOrEqual(2);
    expect(page()).toMatch(/pb-\[calc\(116px\+env\(safe-area-inset-bottom\)\)\]/);
    expect(page()).toMatch(/env\(safe-area-inset-top\)/);
  });
  it('keeps the words the end-to-end spec presses and reads', () => {
    expect(page()).toMatch(/← Back/);
    expect(details()).toMatch(/Record what happened/);
  });
});

// api.ts imports axios and the auth store, so a test cannot import it. It is run for real instead: the
// file is transpiled and evaluated with a recording stand-in for the HTTP client, and the test reads the
// addresses it asks for.
interface RecordedCall { method: string; url: string; body?: unknown }
interface ReasonApi {
  fetchBrief: (userId: string) => Promise<unknown>;
  setPersonResponse: (userId: string, response: 'saved' | 'passed' | null) => Promise<unknown>;
  sendMeetRequest: (userId: string, note: string, format: 'video_20' | 'coffee' | 'message_first') => Promise<unknown>;
  recordOutcomeRequest: (userId: string, worth: 'yes' | 'maybe' | 'no', outcomes: string[]) => Promise<unknown>;
}

function loadApi(): { api: ReasonApi; exported: string[]; calls: RecordedCall[] } {
  const reasonDir = path.join(__dirname, '../../../../client/src/features/reason');
  const calls: RecordedCall[] = [];
  const answer = (method: string) => (url: string, body?: unknown) => {
    calls.push({ method, url, body });
    return Promise.resolve({ data: { data: null } });
  };
  const fakeClient = { get: answer('GET'), put: answer('PUT'), post: answer('POST'), delete: answer('DELETE') };
  const source = fs.readFileSync(path.join(reasonDir, 'api.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (id: string): unknown => (id === '@/lib/api' ? { __esModule: true, default: fakeClient } : require(path.resolve(reasonDir, id)));
  const run = vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`) as (m: unknown, e: unknown, r: unknown) => void;
  run(mod, mod.exports, load);
  return { api: mod.exports as unknown as ReasonApi, exported: Object.keys(mod.exports).sort(), calls };
}

describe('REASON api: a member id is data, never part of the path', () => {
  // React Router hands a route parameter back decoded, so /people/..%2Fpeople%2Fconnections%2Frecent%3F
  // reaches the page as this, and a path built from it by plain interpolation asks for another route.
  const crafted = '../people/connections/recent?';
  const encoded = '..%2Fpeople%2Fconnections%2Frecent%3F';
  const uuid = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';

  it('puts an id into every address as one encoded segment', async () => {
    const { api, calls } = loadApi();
    await api.fetchBrief(crafted);
    await api.setPersonResponse(crafted, 'saved');
    await api.setPersonResponse(crafted, null);
    await api.sendMeetRequest(crafted, 'Hello', 'coffee');
    await api.recordOutcomeRequest(crafted, 'yes', ['advice']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /people/${encoded}/brief`,
      `PUT /people/${encoded}/response`,
      `DELETE /people/${encoded}/response`,
      `POST /matches/platform/${encoded}/interest`,
      `POST /people/${encoded}/outcome`,
    ]);
  });

  it('leaves an ordinary member id as it was, and sends the same bodies', async () => {
    const { api, calls } = loadApi();
    await api.fetchBrief(uuid);
    await api.setPersonResponse(uuid, 'passed');
    await api.sendMeetRequest(uuid, 'Hello', 'video_20');
    await api.recordOutcomeRequest(uuid, 'maybe', ['advice', 'hiring']);
    expect(calls).toEqual([
      { method: 'GET', url: `/people/${uuid}/brief`, body: undefined },
      { method: 'PUT', url: `/people/${uuid}/response`, body: { response: 'passed' } },
      { method: 'POST', url: `/matches/platform/${uuid}/interest`, body: { note: 'Hello', format: 'video_20' } },
      { method: 'POST', url: `/people/${uuid}/outcome`, body: { worthContinuing: 'maybe', outcomes: ['advice', 'hiring'] } },
    ]);
  });

  it('still exports every name the pages import', () => {
    expect(loadApi().exported).toEqual([
      'errorMessage', 'fetchBrief', 'fetchForYou', 'fetchRecentConnections', 'personName', 'reasonKeys',
      'recordOutcomeRequest', 'sendMeetRequest', 'setPersonResponse', 'stateFromPoke',
    ]);
  });
});
