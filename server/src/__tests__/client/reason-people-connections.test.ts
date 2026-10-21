// server/src/__tests__/client/reason-people-connections.test.ts
// Task 7 of the 21 Oct 2026 batch, read as source like the other client pins (the client has no test runner of its
// own), plus api.ts run for real with a stand-in HTTP client. The client's 19 Oct feedback: "On the People page, show
// the user's own connections first." and "On desktop, cards are too long. Show them side by side (two in a row). On
// mobile, keep a single list."
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

const CLIENT = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const withoutComments = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const page = () => read('features/reason/people/ConnectionsPage.tsx');
const card = () => read('features/reason/people/ConnectionCard.tsx');

describe('Your connections: what the page asks for', () => {
  it('asks a page at a time under its own REASON key, and the next page from the last one\'s nextBefore', () => {
    const src = page();
    expect(src).toMatch(/useInfiniteQuery\(\{\s*queryKey: reasonKeys\.connections,\s*queryFn: \(\{ pageParam \}\) => fetchConnections\(pageParam\),\s*initialPageParam: null as string \| null,\s*getNextPageParam: \(last\) => last\.nextBefore \?\? undefined,\s*enabled: !!userId,/);
    // Under ['reason', ...], so a Save (which marks everything REASON has cached as stale) reaches it too.
    expect(read('features/reason/api.ts')).toMatch(/connections: \['reason', 'connections'\] as const,/);
  });

  it('refreshes when a request is accepted (user, invites), a conversation starts (dms) or a block is made either way (blocks), and only then', () => {
    const entities = page().match(/meta: \{ entities: userId \? \[([^\]]*)\] : \[\] \}/);
    expect(entities).not.toBeNull();
    expect([...entities![1].matchAll(/E\.(\w+)\(userId\)/g)].map((m) => m[1]).sort()).toEqual(['user', 'userBlocks', 'userDms', 'userInvites']);
  });

  it('never writes the query cache by hand', () => {
    for (const src of [page(), card()]) expect(withoutComments(src)).not.toMatch(/setQueryData|setQueriesData/);
  });

  it('shows each person once, whatever pages a refetch has moved them between', () => {
    expect(page()).toMatch(/pages\.flatMap\(\(p\) => p\.items\)\.filter\(\(p\) => !seen\.has\(p\.userId\) && !!seen\.add\(p\.userId\)\)/);
    expect(page()).toContain('{people.map((p) => <ConnectionCard key={p.userId} person={p} />)}');
  });
});

describe('Your connections: loading, failing, empty and full', () => {
  it('the error replaces the page only when there is nothing to show, says why when offline, and comes before the skeleton', () => {
    const src = withoutComments(page());
    expect(src).toMatch(/const cannotLoad = data === undefined && \(isError \|\| \(isPending && fetchStatus === 'paused'\)\);/);
    expect(src).toContain('We could not load your connections just now.');
    expect(src).toMatch(/\{fetchStatus === 'paused' && <p [^>]*>\{CONNECTION_LOST\}<\/p>\}/);
    expect(src).toMatch(/<button type="button" onClick=\{tryAgain\} className=\{cn\(BUTTON, [^)]*\)\}>Try again<\/button>/);
    const failed = src.indexOf('{cannotLoad ?');
    const skeleton = src.indexOf(') : isPending ?');
    const nobody = src.indexOf('No connections yet.');
    expect(failed).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(failed);
    expect(nobody).toBeGreaterThan(skeleton);
  });

  it('loads behind a skeleton, never a blank page', () => {
    expect(page()).toMatch(/<div className=\{GRID\} aria-busy="true">[\s\S]*?<Skeleton key=\{i\} className="h-\[132px\]" \/>/);
  });

  it('the empty state is the brief\'s, word for word, with See who fits going to For You', () => {
    const src = page();
    expect(src).toMatch(/<h2 id="connections-title" tabIndex=\{-1\} [^>]*>No connections yet\.<\/h2>/);
    expect(src).toContain('When someone accepts your meeting request, or you meet at an event, they appear here.');
    expect(src).toMatch(/<Link to="\/" className=\{cn\(BUTTON, [^)]*\)\}>See who fits<\/Link>/);
  });

  it('every button and button link is 44px tall', () => {
    expect(page()).toMatch(/^const BUTTON = 'min-h-\[44px\] /m);
    expect(card()).toMatch(/<Link\s+to=\{profileUrl\}\s+aria-label=\{`View profile of \$\{name\}`\}\s+className="[^"]*min-h-\[44px\][^"]*"/);
  });

  it('Show more asks for one page at a time: a second press while the next page is on its way is ignored', () => {
    const src = page();
    expect(src).toContain('const showMore = () => { if (!isFetchingNextPage) void fetchNextPage(); };');
    expect(src).toMatch(/\{hasNextPage && \(/);
    expect(src).toMatch(/onClick=\{showMore\}\s+aria-disabled=\{isFetchingNextPage \|\| undefined\}/);
    expect(src).toContain('We could not load more just now. Try again.');
  });

  it('two to a row from 1024px, one list below, for the cards and the skeleton alike', () => {
    expect(page()).toMatch(/^const GRID = 'grid gap-3 min-\[1024px\]:grid-cols-2';$/m);
    expect(page().match(/className=\{GRID\}/g)).toHaveLength(2);
  });

  it('says "event", never "session", in anything a member reads', () => {
    for (const src of [page(), card()]) {
      expect(withoutComments(src).replace(/^import\b[^;]*;$/gm, '')).not.toMatch(/session/i);
    }
  });
});

describe('Your connections: one person', () => {
  it('opens the one profile page, saying it was found through People; the photo is pointer-only', () => {
    expect(card()).toContain('const profileUrl = `/people/${encodeURIComponent(person.userId)}?from=People`;');
    expect(card()).toMatch(/<Link to=\{profileUrl\} aria-hidden="true" tabIndex=\{-1\} className="block">/);
    expect(card()).toMatch(/<h2 id=\{headingId\}[^>]*>\s*<Link to=\{profileUrl\}/);
    expect(card()).toMatch(/aria-labelledby=\{headingId\}/);
  });

  it('says how the two know each other in the profile\'s own words (Met, Connected), and since when', () => {
    expect(card()).toContain('{STATE_LABEL[person.how]}');
    expect(card()).toMatch(/<time dateTime=\{person\.since\}>/);
  });

  it('a long name or role wraps inside the card, which sizes itself to the room it is given', () => {
    expect(card()).toMatch(/<h2 id=\{headingId\} className="[^"]*\[overflow-wrap:anywhere\]/);
    expect(card()).toMatch(/\{roleLine && <p className="[^"]*\[overflow-wrap:anywhere\]/);
    expect(card()).toMatch(/className="[^"]*\[container-type:inline-size\][^"]*"/);
    expect(card()).toContain('[@container(min-width:30rem)]');
    expect(card()).not.toMatch(/\btruncate\b/);
  });
});

// api.ts imports axios and the auth store, so it is run here with a recording stand-in for the HTTP client.
describe('Your connections: the address it asks', () => {
  const loadApi = () => {
    const reasonDir = path.join(CLIENT, 'features/reason');
    const calls: Array<{ url: string; config: unknown }> = [];
    const fakeClient = { get: (url: string, config?: unknown) => { calls.push({ url, config }); return Promise.resolve({ data: { data: { items: [], nextBefore: null } } }); } };
    const { outputText } = ts.transpileModule(fs.readFileSync(path.join(reasonDir, 'api.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
    });
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    const load = (id: string): unknown => (id === '@/lib/api' ? { __esModule: true, default: fakeClient } : require(path.resolve(reasonDir, id)));
    const run = vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`) as (m: unknown, e: unknown, r: unknown) => void;
    run(mod, mod.exports, load);
    return { fetchConnections: mod.exports.fetchConnections as (before: string | null) => Promise<unknown>, calls };
  };

  it('asks GET /people/connections, with the cursor as a query parameter only when there is one', async () => {
    const { fetchConnections, calls } = loadApi();
    await expect(fetchConnections(null)).resolves.toEqual({ items: [], nextBefore: null });
    await fetchConnections('2026-10-20T09:00:00.000Z');
    expect(calls).toEqual([
      { url: '/people/connections', config: { params: {} } },
      { url: '/people/connections', config: { params: { before: '2026-10-20T09:00:00.000Z' } } },
    ]);
  });
});

// Every person on a People page, and the person heading a conversation, opens the one Human Profile (/people/:id). The
// old /profile/:id page stays for the admin links.
describe('the people pages: one profile page, two to a row from 1024px', () => {
  const PAGES = {
    matches: 'features/matches/MatchesPage.tsx',
    search: 'features/search/SearchPage.tsx',
    agent: 'features/agents/AgentDetailPage.tsx',
    encounters: 'features/sessions/EncounterHistoryPage.tsx',
  } as const;

  it.each(Object.entries(PAGES))('%s links each person to /people/:id?from=People, and to no /profile/ page', (_name, file) => {
    const src = read(file);
    expect(src).toMatch(/to=\{`\/people\/\$\{(m\.userId|r\.userId|m\.candidateUserId|e\.otherUserId)\}\?from=People`\}/);
    expect(src).not.toMatch(/\/profile\//);
  });

  it('the conversation header opens the person\'s Human Profile, saying it was found through Messages', () => {
    const src = read('features/messages/MessagesPage.tsx');
    expect(src).toContain('<Link to={`/people/${headerContext.otherUserId}?from=Messages`} className="min-w-0 flex-1 hover:opacity-80">');
    expect(src).not.toContain('to={`/profile/${headerContext.otherUserId}`}');
  });

  it.each(Object.entries(PAGES))('%s is as wide as max-w-6xl, and its people sit two to a row from 1024px', (_name, file) => {
    const src = read(file);
    expect(src).not.toMatch(/max-w-3xl/);
    expect(src).toMatch(/max-w-6xl/);
    expect(src).toMatch(/className="[^"]*\bgrid gap-3[^"]*min-\[1024px\]:grid-cols-2[^"]*"/);
  });

  it('a search\'s matches sits two to a row in both of its lists', () => {
    expect(read(PAGES.agent).match(/<div className="grid gap-3 min-\[1024px\]:grid-cols-2">/g)).toHaveLength(2);
  });

  it('the Matches footnote spans both columns, and a card puts its button under the name once cards are two to a row', () => {
    const src = read(PAGES.matches);
    expect(src).toMatch(/<p className="col-span-full flex items-center gap-2 text-xs text-gray-400 px-1">\s*<Bell className="h-3\.5 w-3\.5 shrink-0" \/>\s*When you both say yes/);
    expect(src).toContain('<div className="flex flex-col gap-3 sm:max-[1023px]:flex-row sm:max-[1023px]:items-center sm:max-[1023px]:justify-between">');
  });

  it('a long name or role wraps on a half-width card instead of being cut off, and the photo keeps its size', () => {
    for (const file of [PAGES.matches, PAGES.search, PAGES.agent]) {
      const src = read(file);
      // The element that holds the name is not cut off with an ellipsis.
      expect({ file, truncated: /truncate[^"]*">\s*\{(m|r)\.displayName/.test(src) }).toEqual({ file, truncated: false });
      expect(src).toMatch(/size="md" className="shrink-0" \/>/);
    }
    expect(read(PAGES.search)).not.toMatch(/\btruncate\b/);
  });

  it('People you have met: every button is 44px, and a block either way takes the person off the list at once', () => {
    const src = read(PAGES.encounters);
    expect(src.match(/className="min-h-\[44px\]"/g)).toHaveLength(2);
    expect(src).toMatch(/className="inline-flex min-h-\[44px\] items-center gap-1 text-xs text-indigo-600/);
    expect(src).toContain('meta: { entities: currentUserId ? [E.user(currentUserId), E.userBlocks(currentUserId)] : [] },');
  });
});
