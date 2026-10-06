// server/src/__tests__/client/reason-m1-for-you.test.ts
// The For You page (milestone 1, task B4), read as source like the shell test beside it. Each pin is a
// requirement that is easy to lose in an edit and that no type check would notice.
import * as fs from 'fs';
import * as path from 'path';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('features/reason/for-you/ForYouPage.tsx');
const rail = () => read('features/reason/for-you/ForYouRail.tsx');
const empty = () => read('features/reason/for-you/ForYouEmpty.tsx');
// A comment may name what the code leaves out; only the code counts.
const withoutComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');

// WCAG contrast, the same arithmetic the controller measured the colours with.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

describe('For You: what the page asks for, and when it says what', () => {
  it('its query carries the four tags a card or the next event depends on, pods included (the next event follows pod membership)', () => {
    const entities = page().match(/meta: \{ entities: userId \? \[([^\]]*)\] : \[\] \}/);
    expect(entities).not.toBeNull();
    const tags = [...entities![1].matchAll(/E\.(\w+)\(userId\)/g)].map((m) => m[1]);
    expect([...tags].sort()).toEqual(['user', 'userDms', 'userInvites', 'userPods']);
    expect(page()).toMatch(/queryKey: reasonKeys\.forYou,\s*queryFn: fetchForYou,/);
  });

  it('"still loading" is isPending, never isLoading: a paused (offline) fetch has isLoading false and no data, and would read as "no one to suggest"', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/const \{[^}]*\bisPending\b[^}]*\} = useQuery\(/);
    expect(src).not.toMatch(/\bisLoading\b/);
    // The skeleton is decided first; the error and the empty state only ever see an answer.
    const skeleton = src.indexOf('{isPending ?');
    const failed = src.indexOf('isError ?');
    const nobody = src.indexOf('<ForYouEmpty');
    expect(skeleton).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(skeleton);
    expect(nobody).toBeGreaterThan(failed);
  });

  it('the rail never takes "not loaded yet" for "none": no fallback to an empty list, no isLoading, a skeleton until each answer arrives', () => {
    const src = withoutComments(rail());
    expect(src).not.toMatch(/\?\? \[\]/);
    expect(src).not.toMatch(/\bisLoading\b/);
    expect(src).toMatch(/\bSkeleton\b/);
    // ...and a card that could not be answered says so, instead of claiming there is nothing.
    expect(src).toContain('We could not load this just now.');
  });

  it('shows a shortlist of five at most, never the whole list the server sends', () => {
    expect(page()).toMatch(/^const SHORTLIST = 5;$/m);
    expect(page()).toMatch(/\(data\?\.matches \?\? \[\]\)\s*\.slice\(0, SHORTLIST\)/);
  });

  it('the server\'s nullable name and industry go through the shared helpers before they reach the card', () => {
    expect(page()).toMatch(/displayName: personName\(m\.displayName\)/);
    expect(page()).toMatch(/visibleText\(m\.industry\)/);
  });

  it('mounts the welcome popup, outside the data branches so it opens whether the list is loading, failed or shown', () => {
    const src = page();
    expect(src).toMatch(/^import OnboardingWelcomeModal from '@\/features\/onboarding\/OnboardingWelcomeModal';$/m);
    expect(src).toContain('<OnboardingWelcomeModal />');
    expect(src.slice(src.indexOf('<section'), src.indexOf('</section>'))).not.toContain('OnboardingWelcomeModal');
  });
});

describe('For You: Save and the cache', () => {
  it('never writes the query cache by hand', () => {
    for (const src of [page(), rail(), empty()]) expect(withoutComments(src)).not.toMatch(/setQueryData|setQueriesData/);
  });

  it('Save invalidates every REASON query, and waits for the fresh list so the card stays busy until it shows its new state', () => {
    expect(page()).toMatch(/return qc\.invalidateQueries\(\{ queryKey: reasonKeys\.all \}\);/);
  });

  it('a failed Save says why through errorMessage, never the server\'s raw text', () => {
    expect(page()).toMatch(/onError: \(err\) => addToast\(errorMessage\(err, '[^']+'\), 'error'\)/);
  });
});

describe('For You: the rail', () => {
  it('asks for the active pods under a key of its own: ["my-pods", ...] is shared by pages that fetch different URLs, and a query\'s tags belong to its key', () => {
    const src = withoutComments(rail());
    expect(src).toMatch(/queryKey: \['reason', 'rail-pods'\]/);
    expect(src).not.toMatch(/'my-pods'/);
    expect(src).toContain("api.get('/pods?status=active')");
    expect(src).toMatch(/E\.userPods\(userId\)/);
  });

  it('a pod\'s initial is its first whole character (an emoji name is not cut in half), one member reads "1 member", and a blank introduction name reads as "Member"', () => {
    const src = withoutComments(rail());
    expect(src).toMatch(/Array\.from\(p\.name\.trim\(\)\)\[0\]\?\.toUpperCase\(\)/);
    expect(src).toMatch(/p\.memberCount === 1 \? '1 member' : `\$\{p\.memberCount\} members`/);
    expect(src).toMatch(/personName\(r\.displayName\)/);
  });

  it('refreshes recent introductions when a request is answered (user and invite tags)', () => {
    expect(rail()).toMatch(/queryKey: reasonKeys\.recent,[\s\S]*?E\.user\(userId\), E\.userInvites\(userId\)/);
  });

  it('is drawn only from 981px, like the prototype, and invents nothing: no organisations panel, no event photo', () => {
    expect(rail()).toMatch(/<aside aria-label="Your context" className="hidden [^"]*min-\[981px\]:grid">/);
    expect(withoutComments(rail())).not.toMatch(/Suggested entities|<img\b/);
  });

  it('the "Connected" pill is readable: the brief\'s green on mint is 4.18:1, the one used is 4.88:1', () => {
    expect(contrast('#168657', '#e9f8f1')).toBeCloseTo(4.18, 1);
    expect(contrast('#147a4f', '#e9f8f1')).toBeGreaterThanOrEqual(4.5);
    expect(rail()).toMatch(/bg-\[#e9f8f1\][^"]*text-\[#147a4f\]/);
    expect(rail()).not.toContain('#168657');
  });
});

describe('For You: links, words and the buttons the end-to-end spec presses', () => {
  const pathsLinkedFrom = (src: string) => {
    // `${x}` becomes a parameter, so a template literal reads as the route it fills.
    const flat = src.replace(/\$\{[^}]*\}/g, ':param');
    const targets: string[] = [];
    for (const m of flat.matchAll(/\bto=(?:"([^"]*)"|\{([^{}]*)\})/g)) {
      if (m[1] !== undefined) targets.push(m[1]);
      else for (const t of m[2].matchAll(/(['"`])(\/[^'"`]*)\1/g)) targets.push(t[2]);
    }
    return targets.map((t) => t.split('?')[0]);
  };
  const appRoutes = () => [...read('App.tsx').matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
  const routeMatches = (route: string, target: string) =>
    new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(target);

  it('every link on the page goes to a route that exists', () => {
    const targets = [page(), rail(), empty()].flatMap(pathsLinkedFrom);
    for (const wanted of ['/matches', '/sessions', '/sessions/:param', '/pods', '/pods/:param', '/invites', '/messages', '/onboarding', '/people/:param']) {
      expect(targets).toContain(wanted);
    }
    for (const target of new Set(targets)) {
      expect({ target, routed: appRoutes().some((r) => routeMatches(r, target)) }).toEqual({ target, routed: true });
    }
  });

  it('says "event", never "session", in anything a member reads (the URL /sessions is fine)', () => {
    for (const src of [page(), rail(), empty()]) {
      const words = withoutComments(src)
        .replace(/^import\b[^;]*;$/gm, '')
        .replace(/(['"`])\/[^'"`]*\1/g, '');
      expect(words).not.toMatch(/session/i);
    }
  });

  it('keeps the words and the button the end-to-end spec relies on for a failed load', () => {
    expect(page()).toContain('We could not load your people just now.');
    expect(page()).toMatch(/<button type="button" onClick=\{\(\) => refetch\(\)\}[^>]*min-h-\[44px\][^>]*>Try again<\/button>/);
    expect(page()).toContain('role="alert"');
    expect(page().match(/<button\b/g)).toHaveLength(1);
  });

  it('an empty list says what to do next: finish the profile, or an event, an invite, a wider circle', () => {
    expect(empty()).toContain('Finish my profile');
    for (const text of ['See upcoming events', 'Invite people you would like here', 'Browse a wider circle of people']) {
      expect(empty()).toContain(text);
    }
    // A long event title in "Join <title>" wraps instead of running out of its box.
    expect(empty()).toMatch(/const ACTION = '[^']*\[overflow-wrap:anywhere\]/);
  });
});
