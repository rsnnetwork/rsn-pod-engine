// server/src/__tests__/client/auth-rate-limited-keeps-you-signed-in.test.ts
// A rate-limited answer never signs a member out (fix wave 3, 2 Nov 2026).
//
// A member who had used up their minute (240 requests) loaded a page. Its session check (GET /auth/session) was answered
// 429 three more times over about 17 seconds, then the store gave up with no member in it, and the protected page sent
// them to /login: signed out in all but name, although nothing about the session was wrong. Two more paths ended a good
// session over a passing failure: a refresh retried with another tab's newer token that was rate-limited was taken as a
// refusal and emptied the tokens, and a refresh refused with 403 was not taken as a refusal at all.
//
// The rule now: only a real refusal ends a session (401 or 403 from the refresh, a 401 on a token the server has just
// issued, or a closed or suspended account). A 429, a 408, a 5xx or a network failure keeps the member signed in, and the
// check is tried again with growing waits (Retry-After when the answer carries one), until it lands. While it waits with
// no member yet, the page says it is retrying instead of sending anyone to sign in.
//
// EXECUTED, not read: the real authStore.ts is transpiled and run against a fake localStorage and a scripted HTTP client,
// with the real zustand. Timers run at once, and each wait is recorded. ProtectedRoute is rendered for real.
// This scripted client has no 401 interceptor, so every 401 here reaches checkSession's own refresh. The real
// interceptor's paths, a fake clock and exact request counts are in auth-session-check-through-the-interceptor.test.ts.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadClientModule } from './load-client-module';

interface State {
  user: { id: string } | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isSessionChecked: boolean;
  sessionRetrying: boolean;
  signOutReason: string | null;
  checkSession: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
}

/** One scripted answer: a status (200 succeeds), with headers, or a failure that never reached the server. */
type Answer = number | { status: number; headers?: Record<string, string>; code?: string } | 'network';

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (sub: string, n = 0) => [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(JSON.stringify({ sub, n, exp: 4102444800 })), 'sig'].join('.');
const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r)); };

const ME = 'member-me';

function failure(a: Exclude<Answer, 200>): unknown {
  if (a === 'network') return Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  const { status, headers = {}, code } = typeof a === 'number' ? { status: a, headers: {}, code: undefined } : a;
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers, data: code ? { error: { code } } : {} },
  });
}

/** The real store, started the way a tab starts: with this member's tokens already in storage. */
function startTab(script: { session?: Answer[]; refresh?: Answer[] }, opts: { storedTokensChangeOnFirstRefresh?: boolean } = {}) {
  const storage = new Map<string, string>();
  const pair = { access: token(ME), refresh: 'refresh-1' };
  storage.set('rsn_tokens', JSON.stringify(pair));
  storage.set('rsn_access', pair.access);
  storage.set('rsn_refresh', pair.refresh);
  const localStorage = {
    getItem: (k: string) => (storage.has(k) ? (storage.get(k) as string) : null),
    setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    removeItem: (k: string) => { storage.delete(k); },
  };
  const sessionAnswers = [...(script.session ?? [])];
  const refreshAnswers = [...(script.refresh ?? [])];
  const requests: string[] = [];
  let issued = 1;
  const api = {
    get: async (url: string) => {
      requests.push(`GET ${url}`);
      const a = sessionAnswers.length ? sessionAnswers.shift()! : 200;
      if (a !== 200) throw failure(a);
      return { data: { data: { user: { id: ME } } } };
    },
    post: async (url: string, body: { refreshToken?: string }) => {
      requests.push(`POST ${url} ${body?.refreshToken ?? ''}`);
      if (url !== '/auth/refresh') return { data: { data: {} } };
      if (opts.storedTokensChangeOnFirstRefresh && issued === 1) {
        // Another tab rotated the pair while this refresh was on its way.
        storage.set('rsn_tokens', JSON.stringify({ access: token(ME, 99), refresh: 'refresh-other-tab' }));
      }
      const a = refreshAnswers.length ? refreshAnswers.shift()! : 200;
      if (a !== 200) throw failure(a);
      issued += 1;
      return { data: { data: { accessToken: token(ME, issued), refreshToken: `refresh-${issued}` } } };
    },
  };
  const waits: number[] = [];
  const sandbox = {
    window: { addEventListener: () => undefined },
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage,
    atob: globalThis.atob,
    // A wait the store makes before trying again runs at once, and is recorded. The proactive refresh (hours away for
    // these tokens) is never run.
    setTimeout: (fn: () => void, ms: number) => { if (ms <= 120_000) { waits.push(ms); setImmediate(fn); } return 0; },
    clearTimeout: () => undefined,
    Date,
    // The waits' jitter, fixed at none (auth-session-check-through-the-interceptor.test.ts pins the jitter itself).
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
  };
  const source = fs.readFileSync(path.join(__dirname, '../../../../client/src/stores/authStore.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (id: string): unknown => {
    if (id === '@/lib/api') return { __esModule: true, default: api };
    if (id === '@/lib/queryClient') return { clearCache: () => undefined, setCacheOwner: () => undefined };
    return require(id); // zustand
  };
  const run = vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`, sandbox) as (m: unknown, e: unknown, r: unknown) => void;
  run(mod, mod.exports, load);
  const store = mod.exports.useAuthStore as { getState: () => State; subscribe: (fn: (s: State) => void) => () => void };

  // Every moment the protected page would have sent the member to sign in: loaded, and no member.
  const sentToSignIn: string[] = [];
  store.subscribe((s) => { if (!s.isLoading && !s.user) sentToSignIn.push(s.accessToken ? 'tokens kept' : 'tokens gone'); });
  return {
    store,
    storage,
    requests,
    waits,
    sentToSignIn,
    sessionAnswers,
    sessionReads: () => requests.filter((r) => r === 'GET /auth/session').length,
    tokensKept: () => storage.has('rsn_tokens'),
  };
}

describe('the boot check rides out answers that are no refusal, however long they last', () => {
  it.each([
    ['429 (the member used up their minute)', 429],
    ['503', 503],
    ['a network failure', 'network'],
    ['408', 408],
  ] as Array<[string, Answer]>)('%s six times, then the session: signed in, never sent to sign in', async (_label, answer) => {
    const tab = startTab({ session: [answer, answer, answer, answer, answer, answer] });
    const checking = tab.store.getState().checkSession();
    await settle();
    await checking;
    expect(tab.sessionReads()).toBe(7);
    expect(tab.store.getState().user?.id).toBe(ME);
    expect(tab.store.getState().isLoading).toBe(false);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.tokensKept()).toBe(true);
  });

  it('waits longer each time, up to half a minute', async () => {
    const tab = startTab({ session: [429, 429, 429, 429, 429, 429, 429] });
    await tab.store.getState().checkSession();
    expect(tab.waits).toEqual([2000, 5000, 10000, 20000, 30000, 30000, 30000]);
  });

  it('waits as long as Retry-After says, when the answer carries it, but never more than a minute', async () => {
    const tab = startTab({ session: [{ status: 429, headers: { 'retry-after': '7' } }, { status: 429, headers: { 'retry-after': '600' } }, { status: 503, headers: { 'retry-after': '0' } }] });
    await tab.store.getState().checkSession();
    expect(tab.waits).toEqual([7000, 60000, 1000]);
    expect(tab.store.getState().user?.id).toBe(ME);
  });

  it('says it is retrying while it waits with no member, and stops saying so once the session lands', async () => {
    const tab = startTab({ session: [429, 429] });
    const seen: boolean[] = [];
    tab.store.subscribe((s) => seen.push(s.sessionRetrying));
    await tab.store.getState().checkSession();
    expect(seen).toContain(true);
    expect(tab.store.getState().sessionRetrying).toBe(false);
  });

  it('a check with the member already in place (after a save) still gives up after a few tries, keeping the member', async () => {
    const tab = startTab({});
    await tab.store.getState().checkSession();
    expect(tab.store.getState().user?.id).toBe(ME);
    tab.sessionAnswers.push(429, 429, 429, 429, 429, 429, 429, 429);
    await tab.store.getState().checkSession();
    expect(tab.sessionReads()).toBe(1 + 4);
    expect(tab.waits).toEqual([2000, 5000, 10000]);
    expect(tab.store.getState().user?.id).toBe(ME);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.tokensKept()).toBe(true);
  });
});

describe('only a real refusal ends the session', () => {
  it('401 on the session, the refresh rate-limited twice, then refreshed: signed in, tokens kept', async () => {
    const tab = startTab({ session: [401], refresh: [429, 429] });
    await tab.store.getState().checkSession();
    expect(tab.store.getState().user?.id).toBe(ME);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.storage.get('rsn_tokens')).toContain('refresh-2');
  });

  it('a refresh retried with another tab\'s newer token that is rate-limited keeps the session', async () => {
    const tab = startTab({ session: [401], refresh: [401, 429] }, { storedTokensChangeOnFirstRefresh: true });
    await tab.store.getState().checkSession();
    expect(tab.tokensKept()).toBe(true);
    expect(tab.sentToSignIn.filter((s) => s === 'tokens gone')).toEqual([]);
    expect(tab.store.getState().user?.id).toBe(ME);
  });

  it.each([
    ['401', 401],
    ['403', 403],
  ] as Array<[string, Answer]>)('the refresh refused with %s: signed out, tokens gone', async (_label, answer) => {
    const tab = startTab({ session: [401], refresh: [answer] });
    await tab.store.getState().checkSession();
    expect(tab.tokensKept()).toBe(false);
    expect(tab.store.getState().user).toBeNull();
    expect(tab.store.getState().isAuthenticated).toBe(false);
    expect(tab.store.getState().isLoading).toBe(false);
  });

  it('a 401 on the token the server has just issued (the session was revoked): signed out, tokens gone', async () => {
    const tab = startTab({ session: [401, 401], refresh: [200] });
    await tab.store.getState().checkSession();
    expect(tab.tokensKept()).toBe(false);
    expect(tab.store.getState().isAuthenticated).toBe(false);
  });

  it('a closed account still ends the session and says why', async () => {
    const tab = startTab({ session: [401], refresh: [{ status: 401, code: 'ACCOUNT_CLOSED' }] });
    await tab.store.getState().checkSession();
    expect(tab.tokensKept()).toBe(false);
    expect(tab.store.getState().signOutReason).toBe('ACCOUNT_CLOSED');
  });

  it('refreshAccessToken on its own (the 401 interceptor\'s path): a 429 or a 5xx is not a refusal and keeps the tokens', async () => {
    for (const answer of [429, 502, 'network'] as Answer[]) {
      const tab = startTab({ refresh: [answer] });
      await expect(tab.store.getState().refreshAccessToken()).rejects.toMatchObject({ definitive: false });
      expect(tab.tokensKept()).toBe(true);
    }
  });
});

describe('the protected page, while the check is retrying', () => {
  function render(state: Partial<State>): string {
    const full = { user: null, isLoading: true, sessionRetrying: false, ...state };
    const mod = loadClientModule('components/layout/ProtectedRoute.tsx', {
      '@/stores/authStore': { useAuthStore: (pick?: (s: unknown) => unknown) => (pick ? pick(full) : full) },
      'react-router-dom': {
        Navigate: ({ to }: { to: string }) => createElement('a', { 'data-navigate': to }),
        useLocation: () => ({ pathname: '/messages', search: '' }),
      },
      '@/components/ui/Spinner': { PageLoader: () => createElement('span', { 'data-loader': '' }) },
    });
    const ProtectedRoute = mod.default as (p: { children?: unknown }) => unknown;
    return renderToStaticMarkup(createElement(ProtectedRoute as never, null, createElement('main', null, 'page')));
  }

  it('says it is retrying, in words, and sends nobody to sign in', () => {
    const html = render({ isLoading: true, sessionRetrying: true });
    expect(html).toContain('data-testid="session-retrying"');
    expect(html).toContain('Connection lost, retrying');
    expect(html).not.toContain('data-navigate');
  });

  it('shows only the loader while the first check is on its way', () => {
    const html = render({ isLoading: true, sessionRetrying: false });
    expect(html).toContain('data-loader');
    expect(html).not.toContain('session-retrying');
  });
});
