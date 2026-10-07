// server/src/__tests__/client/reason-m1-for-you.test.ts
// The For You page (milestone 1, task B4), read as source like the shell test beside it, plus the one pure
// helper it owns, executed. Each pin is a requirement that is easy to lose in an edit and that no type check
// would notice.
import * as fs from 'fs';
import * as path from 'path';
import { CONNECTION_LOST, errorMessage } from '../../../../client/src/features/reason/errors';
import { firstCharacter } from '../../../../client/src/features/reason/for-you/firstCharacter';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('features/reason/for-you/ForYouPage.tsx');
const rail = () => read('features/reason/for-you/ForYouRail.tsx');
const empty = () => read('features/reason/for-you/ForYouEmpty.tsx');
// A comment may name what the code leaves out; only the code counts.
const withoutComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');

// WCAG 2 contrast: the ratio of the two colours' relative luminance, each raised by 0.05.
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
  });

  it('a fetch waiting for the network, with nothing to show yet, is an error the member can read, not a skeleton for ever', () => {
    const src = withoutComments(page());
    // fetchStatus is how the query says "paused": the request exists and is waiting for the connection.
    expect(src).toMatch(/const \{[^}]*\bfetchStatus\b[^}]*\} = useQuery\(/);
    expect(src).toMatch(/const waitingForConnection = isPending && fetchStatus === 'paused';/);
    expect(src).toMatch(/const cannotLoad = data === undefined && \(isError \|\| waitingForConnection\);/);
    // The error branch is decided before the skeleton, and the empty state only ever sees an answer.
    const failed = src.indexOf('{cannotLoad ?');
    const skeleton = src.indexOf(') : isPending ?');
    const nobody = src.indexOf('<ForYouEmpty');
    expect(failed).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(failed);
    expect(nobody).toBeGreaterThan(skeleton);
  });

  it('the error is only ever shown when there is no list: a failed refresh keeps the list that is on screen', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/const cannotLoad = data === undefined && /);
    // No branch asks isError on its own: that is how a good list used to be swapped for the error.
    expect(src).not.toMatch(/isError \?|\{isError\b|&& isError\b/);
  });

  it('while a request waits for the network the error says why, in errors.ts\'s one sentence for a lost connection, taken as it is', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/^import \{ CONNECTION_LOST \} from '\.\.\/errors';$/m);
    expect(src).not.toMatch(/const CONNECTION_LOST\b/);
    // Never made by asking errorMessage about "no error": a request the library holds back has none, errorMessage can only
    // say the caller's fallback for that (it is no lost connection as far as it can tell), and offline the member read it.
    expect(src).not.toMatch(/errorMessage\((undefined|null)\b/);
    expect(src).toMatch(/\{fetchStatus === 'paused' && <p [^>]*>\{CONNECTION_LOST\}<\/p>\}/);
  });

  it('...and that sentence is what a real lost connection gets, while "no error" still gets the caller\'s fallback (executed)', () => {
    const lost = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', request: {} });
    expect(CONNECTION_LOST).toBe('Connection lost. Check your internet and try again.');
    expect(errorMessage(lost, 'fallback')).toBe(CONNECTION_LOST);
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
  });

  it('the rail never takes "not loaded yet" for "none": no fallback to an empty list, no isLoading, a skeleton until each answer arrives', () => {
    const src = withoutComments(rail());
    expect(src).not.toMatch(/\?\? \[\]/);
    expect(src).not.toMatch(/\bisLoading\b/);
    expect(src).toMatch(/\bSkeleton\b/);
    // ...and a card that could not be answered says so, instead of claiming there is nothing.
    expect(src).toContain('We could not load this just now.');
  });

  it('each rail card is decided by what its own request has said: no answer yet is pending, a failed or paused request is failed, any answer is ready', () => {
    const src = withoutComments(rail());
    expect(src).toContain("const loadOf = (data: unknown, failed: boolean): Load => (data !== undefined ? 'ready' : failed ? 'failed' : 'pending');");
    expect(src).toContain("const cannotAnswer = (q: { isError: boolean; fetchStatus: string }) => q.isError || q.fetchStatus === 'paused';");
    expect(src).toContain('load={loadOf(nextEvent, failed)}');
    expect(src).toContain('load={loadOf(pods.data, cannotAnswer(pods))}');
    expect(src).toContain('load={loadOf(recent.data, cannotAnswer(recent))}');
    // The rail's cards read their answer from the same objects the loads were decided from.
    expect(src).toMatch(/pods\.data\?\.length === 0/);
    expect(src).toMatch(/recent\.data\?\.length === 0/);
  });

  it('hands the rail only what the page does not know yet: undefined until For You answers, and whether it could not', () => {
    expect(page()).toContain('<ForYouRail nextEvent={data?.nextEvent} failed={cannotLoad} />');
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
  const saveCall = () => {
    const src = withoutComments(page());
    const start = src.indexOf('const save = useMutation({');
    const end = src.indexOf('\n  });', start);
    expect({ found: start > -1 && end > start }).toEqual({ found: true });
    return src.slice(start, end);
  };

  it('never writes the query cache by hand', () => {
    for (const src of [page(), rail(), empty()]) expect(withoutComments(src)).not.toMatch(/setQueryData|setQueriesData/);
  });

  it('a Save made with no connection fails at once, with errorMessage\'s connection sentence, instead of waiting behind a card that looks busy', () => {
    expect(saveCall()).toMatch(/networkMode: 'always',/);
    expect(saveCall()).toMatch(/onError: \(err\) => \{\s*addToast\(errorMessage\(err, '[^']+'\), 'error'\);/);
  });

  it('every Save carries one key, and each card is busy for ITS OWN request: the page asks which people have a Save in flight', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/^const SAVE_KEY = \['reason', 'save-person'\] as const;$/m);
    expect(saveCall()).toMatch(/mutationKey: SAVE_KEY,/);
    expect(src).toMatch(/useMutationState\(\{\s*filters: \{ mutationKey: SAVE_KEY, status: 'pending' \},/);
    expect(src).toMatch(/\(m\.state\.variables as HumanCardPerson\)\.userId/);
    expect(src).toContain('busy={saving.includes(p.userId)}');
    // One useMutation only tracks its latest call, so the page must not read busy from it.
    expect(src).not.toMatch(/save\.isPending|save\.variables/);
  });

  it('after a Save everything REASON has cached is marked stale, but only the For You list is fetched again and waited for', () => {
    const src = withoutComments(page());
    expect(saveCall()).toContain("await qc.invalidateQueries({ queryKey: reasonKeys.all, refetchType: 'none' });");
    expect(saveCall()).toContain('await qc.invalidateQueries({ queryKey: reasonKeys.forYou });');
    // Two on success, and the one a 404 makes (the next test).
    const onSuccess = saveCall().slice(saveCall().indexOf('onSuccess:'), saveCall().indexOf('onError:'));
    expect(onSuccess.match(/invalidateQueries\(/g)).toHaveLength(2);
    expect(src.match(/invalidateQueries\(/g)).toHaveLength(3);
    // No invalidation of the whole REASON namespace may refetch: the rail's two requests are not the Save's to refresh.
    for (const call of src.matchAll(/invalidateQueries\(\{ queryKey: reasonKeys\.all[^)]*\)/g)) expect(call[0]).toContain("refetchType: 'none'");
  });

  it('a Save that answers 404 (the person is gone) fetches the For You list again, so their card goes instead of staying with live buttons; the refetch is returned, so the card stays busy until it is in', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/^import \{ statusOf \} from '\.\.\/human\/profile-text';$/m);
    const onError = saveCall().slice(saveCall().indexOf('onError:'));
    expect(onError).toContain("return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: reasonKeys.forYou }) : undefined;");
    // The toast still says why (errorMessage's 404 sentence), and comes first.
    expect(onError.indexOf('addToast(')).toBeGreaterThan(-1);
    expect(onError.indexOf('addToast(')).toBeLessThan(onError.indexOf('statusOf(err)'));
  });
});

describe('For You: the keyboard', () => {
  const headings = () => [page(), rail(), empty()].flatMap((src) => [...src.matchAll(/<h2 id="foryou-title"[^>]*>/g)].map((m) => m[0]));

  it('"Try again" hands focus to the section heading once the answer is in, because the button disappears under the member', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/const tryAgain = \(\) => \{ retrying\.current = true; void refetch\(\); \};/);
    expect(src).toMatch(/<button type="button" onClick=\{tryAgain\} [^>]*min-h-\[44px\][^>]*>Try again<\/button>/);
    const effect = src.slice(src.indexOf('useEffect(() => {'), src.indexOf('}, [isPending, isError]);'));
    expect(effect).toContain('if (isPending || !retrying.current) return;');
    expect(effect).toContain("section.current?.querySelector<HTMLElement>('#foryou-title')?.focus();");
    expect(src).toMatch(/<section ref=\{section\} aria-labelledby="foryou-title"/);
  });

  it('every heading that can be focused is focusable (tabIndex -1) and draws no ring on a heading; the screen-reader-only loading one is not', () => {
    const all = headings();
    expect(all).toHaveLength(5); // loading, could not load, the list, and the two empty states
    const loading = all.filter((h) => h.includes('sr-only'));
    expect(loading).toHaveLength(1);
    for (const h of all.filter((x) => !x.includes('sr-only'))) {
      expect(h).toContain('tabIndex={-1}');
      expect(h).toContain('outline-none');
    }
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

  it('a pod\'s initial is its first whole character, one member reads "1 member", and a blank introduction name reads as "Member"', () => {
    const src = withoutComments(rail());
    expect(src).toMatch(/\{firstCharacter\(p\.name\)\}/);
    expect(src).toMatch(/p\.memberCount === 1 \? '1 member' : `\$\{p\.memberCount\} members`/);
    expect(src).toMatch(/personName\(r\.displayName\)/);
  });

  it('a row is read once: the pod\'s initial and the introduction\'s photo are decoration beside the name, so a screen reader skips them', () => {
    const src = withoutComments(rail());
    expect(src).toMatch(/<span aria-hidden="true" className="[^"]*">\{firstCharacter\(p\.name\)\}<\/span>/);
    expect(src).toMatch(/<span aria-hidden="true"[^>]*><Avatar [^>]*\/><\/span>/);
  });

  it('every "View all" says what it opens (the visible words stay inside the name): people, events, pods, introductions', () => {
    expect(page()).toMatch(/<Link to="\/matches" aria-label="View all people" [^>]*>View all<\/Link>/);
    const src = withoutComments(rail());
    expect(src).toMatch(/<Link to=\{to\} aria-label=\{`View all \$\{all\}`\} [^>]*>View all<\/Link>/);
    for (const [title, to, all] of [['Your next event', '/sessions', 'events'], ['Your pods', '/pods', 'pods'], ['Recent introductions', '/messages', 'introductions']]) {
      expect(src).toContain(`<RailCard title="${title}" to="${to}" all="${all}" `);
    }
  });

  it('refreshes recent introductions when a request is answered (user and invite tags)', () => {
    expect(rail()).toMatch(/queryKey: reasonKeys\.recent,[\s\S]*?E\.user\(userId\), E\.userInvites\(userId\)/);
  });

  it('is drawn only from 981px, like the prototype, and invents nothing: no organisations panel, no event photo', () => {
    expect(rail()).toMatch(/<aside aria-label="Your context" className="hidden [^"]*min-\[981px\]:grid">/);
    expect(withoutComments(rail())).not.toMatch(/Suggested entities|<img\b/);
  });

  it('the "Connected" pill is readable: its green on mint is 4.88:1', () => {
    expect(contrast('#147a4f', '#e9f8f1')).toBeCloseTo(4.88, 1);
    expect(rail()).toMatch(/bg-\[#e9f8f1\][^"]*text-\[#147a4f\]/);
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
    expect(page()).toContain('role="alert"');
    expect(page().match(/<button\b/g)).toHaveLength(1);
  });

  it('an empty list says what to do next: finish the profile, or an event, an invite, a wider circle', () => {
    expect(empty()).toContain('Finish my profile');
    for (const text of ['See upcoming events', 'Invite people you would like here', 'Browse a wider circle of people']) {
      expect(empty()).toContain(text);
    }
    // A long event title in "Join <title>" wraps instead of running out of its box.
    const action = empty().match(/const ACTION = ([^;]+);/)?.[1];
    expect(action).toContain('[overflow-wrap:anywhere]');
  });
});

describe('firstCharacter: the character a person sees first in a name', () => {
  // Written as escapes: a flag, a family joined by zero-width joiners, a hand with a skin tone.
  const FLAG = '\u{1F1E9}\u{1F1EA}';
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const THUMBS = '\u{1F44D}\u{1F3FD}';
  const ROCKET = '\u{1F680}';

  it('is the upper-case first letter of a plain name, with spaces ignored', () => {
    expect(firstCharacter('zebra crossing')).toBe('Z');
    expect(firstCharacter('  spaced out ')).toBe('S');
    expect(firstCharacter('\u00e9cole')).toBe('\u00c9');
  });

  it('is nothing for nothing', () => {
    expect(firstCharacter('')).toBe('');
    expect(firstCharacter('   ')).toBe('');
  });

  it('keeps a whole emoji whole, whatever it is made of: a flag, a family, a skin tone, a plain one', () => {
    expect(firstCharacter(`${FLAG} Berlin`)).toBe(FLAG);
    expect(firstCharacter(`${FAMILY} Family office`)).toBe(FAMILY);
    expect(firstCharacter(`${THUMBS} Thumbs up`)).toBe(THUMBS);
    expect(firstCharacter(`${ROCKET} Rockets`)).toBe(ROCKET);
  });

  it('keeps a letter with its combining accent together (e then an accent is one letter)', () => {
    expect(firstCharacter('e\u0301cole')).toBe('E\u0301');
  });

  it('where a browser has no segmenter it falls back to the first code point: a plain emoji and a letter are still whole, a flag is not', () => {
    expect(firstCharacter('zebra', null)).toBe('Z');
    expect(firstCharacter(`${ROCKET} Rockets`, null)).toBe(ROCKET);
    expect(firstCharacter(`${FLAG} Berlin`, null)).toBe('\u{1F1E9}');
  });

  it('is what the rail draws: no charAt, no code-unit split', () => {
    expect(withoutComments(rail())).not.toMatch(/charAt\(0\)|\[0\]\?\.toUpperCase/);
  });
});
