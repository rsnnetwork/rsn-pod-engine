// server/src/__tests__/client/query-cache-per-member.test.ts
// The client's query cache belongs to ONE signed-in member at a time.
//
// It did not. The QueryClient was built in main.tsx, remembered every query for five minutes, and nothing
// ever emptied it: a member who signed in within five minutes of the last one opened pages that already
// held the previous member's data (REASON's For You carried that member's private "you are looking for" on
// every card) until their own answer arrived. The cache logic is EXECUTED here (it needs no store, router
// or axios); the call sites in the auth store and main.tsx are pinned as source.
import * as fs from 'fs';
import * as path from 'path';
import { MutationObserver } from '@tanstack/react-query';
import { clearCache, queryClient, setCacheOwner } from '../../../../client/src/lib/queryClient';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

const forYou = ['reason', 'for-you'];
const pods = ['reason', 'rail-pods'];
const seed = (owner: string) => {
  queryClient.setQueryData(forYou, { youAreLookingFor: `${owner}'s private want` });
  queryClient.setQueryData(pods, [{ name: `${owner}'s pod` }]);
};
const cached = () => [queryClient.getQueryData(forYou), queryClient.getQueryData(pods)];

beforeEach(() => clearCache());
afterAll(() => clearCache());

describe('the one query cache the whole app reads through', () => {
  it('keeps the settings main.tsx used to build it with', () => {
    expect(queryClient.getDefaultOptions().queries).toEqual({ staleTime: 5_000, retry: 1, refetchOnWindowFocus: true });
  });
});

describe('the cache is emptied when the member changes', () => {
  it('keeps everything for the same member: a token refresh and a session re-check read the same id', () => {
    setCacheOwner('member-a');
    seed('A');
    setCacheOwner('member-a');
    setCacheOwner('member-a');
    expect(cached()).toEqual([{ youAreLookingFor: "A's private want" }, [{ name: "A's pod" }]]);
  });

  it('drops everything the moment a DIFFERENT member is known, so the next page starts from nothing', () => {
    setCacheOwner('member-a');
    seed('A');
    setCacheOwner('member-b');
    expect(cached()).toEqual([undefined, undefined]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('data the next member fetches stays theirs: it is kept while they are the one signed in', () => {
    setCacheOwner('member-a');
    seed('A');
    setCacheOwner('member-b');
    seed('B');
    setCacheOwner('member-b');
    expect(cached()).toEqual([{ youAreLookingFor: "B's private want" }, [{ name: "B's pod" }]]);
  });

  it('drops everything on sign-out, and the same member coming back starts from nothing too', () => {
    setCacheOwner('member-a');
    seed('A');
    clearCache();
    expect(cached()).toEqual([undefined, undefined]);
    setCacheOwner('member-a');
    expect(cached()).toEqual([undefined, undefined]);
  });

  it('a session that ended without a sign-out (expired, or ended in another tab) still cannot hand its data to the next member', () => {
    setCacheOwner('member-a');
    seed('A');
    // Nothing signs A out here: the session just stops, and a different member signs in later.
    setCacheOwner('member-b');
    expect(cached()).toEqual([undefined, undefined]);
  });

  it('what was cached before anyone was known (nobody owns it yet) is not thrown away by the first member', () => {
    seed('public');
    setCacheOwner('member-a');
    expect(cached()).toEqual([{ youAreLookingFor: "public's private want" }, [{ name: "public's pod" }]]);
  });

  it('an answer still on its way for the previous member never lands in the new member\'s cache', async () => {
    let answer: (v: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => { answer = resolve; });
    setCacheOwner('member-a');
    const pending = queryClient.fetchQuery({ queryKey: forYou, queryFn: () => late, retry: false }).catch(() => 'cancelled');
    setCacheOwner('member-b');
    answer("A's late answer");
    await pending;
    expect(queryClient.getQueryData(forYou)).toBeUndefined();
  });

  it('a Save still in flight for the previous member is dropped with the rest', () => {
    setCacheOwner('member-a');
    void new MutationObserver(queryClient, { mutationKey: ['reason', 'save-person'], mutationFn: (_who: { userId: string }) => new Promise<void>(() => undefined) })
      .mutate({ userId: 'x' }).catch(() => undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    setCacheOwner('member-b');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

// The body of one function or block, from a marker to the next marker, so a pin cannot be satisfied by a
// call that happens to sit elsewhere in the file.
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  expect({ marker: from, found: start > -1 && end > -1 }).toEqual({ marker: from, found: true });
  return src.slice(start, end);
};

describe('the call sites: main.tsx and the auth store', () => {
  const store = () => read('stores/authStore.ts');

  it('main.tsx uses the shared client and builds none of its own', () => {
    const main = read('main.tsx');
    expect(main).toMatch(/import \{ queryClient \} from '\.\/lib\/queryClient';/);
    expect(main).toMatch(/<QueryClientProvider client=\{queryClient\}>/);
    expect(main).not.toMatch(/new QueryClient\(/);
  });

  it('nothing else in the app builds a client of its own (a second cache would escape the clearing)', () => {
    const files: string[] = [];
    // The realtime guard's test makes and removes client/src/__test_realtime_guard__ while the suites run side by side. It
    // is not the app, and a file listed from it can be gone by the time it is read (an ENOENT that failed this test now and then).
    const walk = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.name.startsWith('__test_')) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else if (/\.tsx?$/.test(e.name)) files.push(full);
    });
    walk(path.join(__dirname, '../../../../client/src'));
    const builders = files.filter((f) => /new QueryClient\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f));
    expect(builders).toEqual(['queryClient.ts']);
  });

  it('signing out empties the cache', () => {
    expect(between(store(), 'logout: async () => {', 'setTokens: (access')).toMatch(/clearCache\(\);/);
  });

  it('a session ended because the account is blocked empties the cache', () => {
    expect(between(store(), 'endBlockedSession: (reason: string) => {', '// ── Cross-Tab Auth Sync')).toMatch(/clearCache\(\);/);
  });

  it('a session that expired for good empties the cache', () => {
    expect(between(store(), 'if (definitive && authEpoch === epochAtStart) {', '} else {')).toMatch(/clearCache\(\);/);
  });

  it('a sign-out made in another tab empties this tab\'s cache too', () => {
    expect(between(store(), '// Another tab logged out', 'document.addEventListener')).toMatch(/clearCache\(\);/);
  });

  it('a session loaded for a member says whose it is, BEFORE the page can read it (both places the session is read)', () => {
    const src = store();
    const reads = [...src.matchAll(/set\(\{ user: data\.data\.user,/g)];
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(src.slice(Math.max(0, read.index! - 80), read.index)).toMatch(/setCacheOwner\(data\.data\.user\.id\);\s*$/);
    }
  });

  it('a token refresh for the same member touches nothing: installing tokens and refreshing them never clear the cache', () => {
    const src = store();
    expect(between(src, 'const installTokens', 'return {\n    user: null')).not.toMatch(/clearCache|setCacheOwner/);
    expect(between(src, 'refreshAccessToken: async () => {', 'logout: async () => {')).not.toMatch(/clearCache|setCacheOwner/);
  });
});
