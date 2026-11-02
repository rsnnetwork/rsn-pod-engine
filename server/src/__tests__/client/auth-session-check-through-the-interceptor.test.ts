// server/src/__tests__/client/auth-session-check-through-the-interceptor.test.ts
// The session check, run through the REAL 401 interceptor (429 fix round 1, 2 Nov 2026).
//
// The first round's suite gave the store a fake HTTP client with no interceptor, so every 401 reached checkSession's own
// refresh branch, which the real app only reaches on a second 401. Three faults hid there:
//   1. A refused refresh after the session read's 401 came back as the interceptor's RefreshError, which has no status,
//      so it was taken as a passing failure: the member waited on "Connection lost, retrying…" for ever, posting a dead
//      refresh token every half a minute.
//   2. An expired access token: the interceptor's refresh moved the session epoch, the retried read was rate-limited, and
//      the check took its own refresh for another session taking over and gave up with no member: sent to sign in.
//   3. A check superseded by a newer one still wrote the store when it woke, and sent the member to sign in while the
//      newer check was still waiting.
//
// Here the real api.ts (its axios instance, both interceptors) and the real authStore.ts are transpiled and run together
// against a scripted HTTP adapter under that axios instance, a fake localStorage and a fake clock. The adapter answers as
// the server does: a read with an expired access token is 401, everything else follows the script.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AxiosError } from 'axios';
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
  retrySessionNow: () => Promise<void>;
  refreshAccessToken: () => Promise<void>;
  adoptStoredTokens: () => boolean;
  logout: () => Promise<void>;
}

/** One scripted answer: a status (200 succeeds), with headers or an error code, or a failure that never reached the server. */
type Answer = number | { status: number; headers?: Record<string, string>; code?: string } | 'network';

interface Sent { method: string; url: string; bearer: string | null; refreshToken?: string; at: number }

const ME = 'member-me';
const OTHER = 'member-other';
const FAR = 4102444800; // 2100: the proactive refresh is never due in these tests
const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (sub: string, n: number, exp = FAR) => [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(JSON.stringify({ sub, n, exp })), 'sig'].join('.');
const claims = (jwt: string | null): { sub?: string; exp?: number } => {
  try { return JSON.parse(Buffer.from((jwt ?? '').split('.')[1], 'base64').toString('utf8')); } catch { return {}; }
};
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r)); };

function compile(rel: string): string {
  const source = fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
}

/** A tab started the way a real one starts: this member's tokens in storage, the real api.ts and authStore.ts loaded. */
function startTab(script: { session?: Answer[]; refresh?: Answer[] } = {}, opts: { accessExpired?: boolean; random?: number } = {}) {
  const storage = new Map<string, string>();
  const pair = { access: token(ME, 1, opts.accessExpired ? 1_000_000 : FAR), refresh: 'refresh-1' };
  storage.set('rsn_tokens', JSON.stringify(pair));
  storage.set('rsn_access', pair.access);
  storage.set('rsn_refresh', pair.refresh);
  const localStorage = {
    getItem: (k: string) => (storage.has(k) ? (storage.get(k) as string) : null),
    setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    removeItem: (k: string) => { storage.delete(k); },
  };

  // The fake clock: timers run only when the test moves time on.
  const clock = { now: 0, nextId: 1 };
  const timers = new Map<number, { due: number; ms: number; fn: () => void }>();
  const waits: number[] = [];
  const setTimeoutFake = (fn: () => void, ms: number) => {
    const id = clock.nextId++;
    timers.set(id, { due: clock.now + ms, ms, fn });
    if (ms <= 120_000) waits.push(ms);
    return id;
  };
  const clearTimeoutFake = (id: number) => { timers.delete(id); };

  const sessionAnswers = [...(script.session ?? [])];
  const refreshAnswers = [...(script.refresh ?? [])];
  const sent: Sent[] = [];
  let issued = 1;
  // Session reads held on their way (the server has not answered yet) until the test lets them through.
  let holdingReads = false;
  const heldReads: Array<() => void> = [];
  const adapter = async (config: { url: string; method: string; headers: Record<string, unknown>; data?: string }) => {
    const auth = typeof config.headers?.Authorization === 'string' ? (config.headers.Authorization as string) : null;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const body = config.data ? JSON.parse(config.data) : {};
    sent.push({ method: config.method.toUpperCase(), url: config.url, bearer, refreshToken: body.refreshToken, at: clock.now });
    if (config.url === '/auth/session' && holdingReads) await new Promise<void>((answer) => heldReads.push(answer));
    let answer: Answer = 200;
    let data: unknown = { data: {} };
    if (config.url === '/auth/session') {
      const c = claims(bearer);
      // The server: an expired or missing access token is refused before the limiter can key it by member.
      if (!c.sub || (c.exp ?? 0) * 1000 < Date.now()) answer = 401;
      else answer = sessionAnswers.length ? sessionAnswers.shift()! : 200;
      data = { data: { user: { id: c.sub } } };
    } else if (config.url === '/auth/refresh') {
      answer = refreshAnswers.length ? refreshAnswers.shift()! : 200;
      if (answer === 200) {
        issued += 1;
        const sub = body.refreshToken === 'refresh-other' ? OTHER : ME;
        data = { data: { accessToken: token(sub, issued), refreshToken: `refresh-${issued}` } };
      }
    }
    if (answer === 'network') throw new AxiosError('Network Error', 'ERR_NETWORK', config as never, {});
    const { status, headers = {}, code } = typeof answer === 'number' ? { status: answer, headers: {}, code: undefined } : answer;
    const response = { status, statusText: String(status), headers, config, request: {}, data: status === 200 ? data : code ? { error: { code } } : {} };
    if (status === 200) return response;
    throw new AxiosError(`Request failed with status code ${status}`, status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config as never, {}, response as never);
  };

  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const sandbox = {
    window: { addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); } },
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage,
    atob: globalThis.atob,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    Date,
    // The jitter's randomness, fixed: 0.5 is no jitter at all.
    Math: Object.assign(Object.create(Math), { random: () => opts.random ?? 0.5 }),
  };
  const context = vm.createContext(sandbox);
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const files: Record<string, string> = { '@/lib/api': 'lib/api.ts', '@/stores/authStore': 'stores/authStore.ts' };
  const load = (id: string): unknown => {
    if (id === '@/lib/runtimeEndpoints') return { API_BASE_URL: 'http://api.test/api' };
    if (id === '@/lib/queryClient') return { clearCache: () => undefined, setCacheOwner: () => undefined };
    const rel = files[id];
    if (!rel) return require(id); // axios, zustand
    const cached = modules.get(id);
    if (cached) return cached.exports;
    const mod = { exports: {} as Record<string, unknown> };
    modules.set(id, mod);
    const run = vm.runInContext(`(function (module, exports, require) {${compile(rel)}\n})`, context) as (m: unknown, e: unknown, r: unknown) => void;
    run(mod, mod.exports, load);
    return mod.exports;
  };
  const store = (load('@/stores/authStore') as { useAuthStore: { getState: () => State; setState: (s: Partial<State>) => void; subscribe: (fn: (s: State) => void) => () => void } }).useAuthStore;
  const api = (load('@/lib/api') as { default: { defaults: { adapter: unknown } } }).default;
  api.defaults.adapter = adapter;

  // Every moment the protected page would have sent the member to sign in: loaded, and no member.
  const sentToSignIn: string[] = [];
  const retryingSeen: boolean[] = [];
  store.subscribe((s) => {
    if (!s.isLoading && !s.user) sentToSignIn.push(s.accessToken ? 'tokens kept' : 'tokens gone');
    retryingSeen.push(s.sessionRetrying);
  });

  /** Moves the fake clock on by `ms`, running every timer that falls due, in order, and the promises they start. */
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      await settle();
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const entry of timers) if (entry[1].due <= until && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      timers.delete(next[0]);
      clock.now = next[1].due;
      next[1].fn();
    }
    clock.now = until;
    await settle();
  };

  return {
    store,
    state: () => store.getState(),
    storage,
    sent,
    waits,
    sentToSignIn,
    retryingSeen,
    sessionAnswers,
    advance,
    now: () => clock.now,
    reads: () => sent.filter((r) => r.url === '/auth/session'),
    refreshes: () => sent.filter((r) => r.url === '/auth/refresh'),
    /** Timers due within two minutes: the retry waits (the proactive refresh is decades away). */
    pendingWaits: () => [...timers.values()].filter((t) => t.ms <= 120_000).length,
    tokensKept: () => storage.has('rsn_tokens'),
    fireStorage: (key: string, newValue: string | null) => { for (const fn of listeners.storage ?? []) fn({ key, newValue }); },
    /** From now on, a session read stays on its way until `answerHeldReads`. */
    holdSessionReads: () => { holdingReads = true; },
    answerHeldReads: () => { holdingReads = false; for (const answer of heldReads.splice(0)) answer(); },
  };
}

describe('finding 1: a refresh the server refuses, after the session read\'s 401, ends the session at once', () => {
  it.each([
    ['401', 401],
    ['403', 403],
  ] as Array<[string, Answer]>)('refused with %s: signed out, tokens gone, and nothing more is sent', async (_label, answer) => {
    const tab = startTab({ refresh: [answer] }, { accessExpired: true });
    void tab.state().checkSession();
    await tab.advance(0);
    expect(tab.state().isAuthenticated).toBe(false);
    expect(tab.state().isLoading).toBe(false);
    expect(tab.state().sessionRetrying).toBe(false);
    expect(tab.state().user).toBeNull();
    expect(tab.tokensKept()).toBe(false);
    await tab.advance(120_000);
    expect(tab.sent.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /auth/session', 'POST /auth/refresh']);
  });

  it('a closed account refused by the interceptor\'s refresh still says why', async () => {
    const tab = startTab({ refresh: [{ status: 401, code: 'ACCOUNT_CLOSED' }] }, { accessExpired: true });
    void tab.state().checkSession();
    await tab.advance(0);
    expect(tab.state().signOutReason).toBe('ACCOUNT_CLOSED');
    expect(tab.state().isLoading).toBe(false);
    expect(tab.tokensKept()).toBe(false);
    await tab.advance(120_000);
    expect(tab.sent).toHaveLength(2);
  });

  it('the interceptor\'s refresh rate-limited is passing: it waits, refreshes, and lands signed in', async () => {
    const tab = startTab({ refresh: [429] }, { accessExpired: true });
    const checking = tab.state().checkSession();
    await tab.advance(0);
    expect(tab.state().isLoading).toBe(true);
    expect(tab.state().sessionRetrying).toBe(true);
    await tab.advance(2000);
    await checking;
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.sent.map((r) => `${r.at} ${r.method} ${r.url}`)).toEqual([
      '0 GET /auth/session', '0 POST /auth/refresh', '2000 GET /auth/session', '2000 POST /auth/refresh', '2000 GET /auth/session',
    ]);
  });
});

describe('finding 2: an expired access token, then a rate-limited read, keeps the member waiting, never sent to sign in', () => {
  it('401, the interceptor refreshes, the retried read is 429 twice, then the session lands', async () => {
    const tab = startTab({ session: [429, 429] }, { accessExpired: true });
    const checking = tab.state().checkSession();
    await tab.advance(0);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.state().isLoading).toBe(true);
    expect(tab.state().sessionRetrying).toBe(true);
    await tab.advance(2000 + 5000);
    await checking;
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.refreshes()).toHaveLength(1);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 0, 2000, 7000]);
    expect(tab.storage.get('rsn_tokens')).toContain('refresh-2');
  });

  it('a refresh of the same member\'s tokens while it waits (the proactive one, a tab coming back) does not end the wait', async () => {
    const tab = startTab({ session: [429, 429] });
    const checking = tab.state().checkSession();
    await tab.advance(0);
    await tab.state().refreshAccessToken();
    await tab.advance(2000);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.state().isLoading).toBe(true);
    await tab.advance(5000);
    await checking;
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.reads()).toHaveLength(3);
  });
});

describe('finding 3: only the newest check may change the store', () => {
  it('a check superseded while it waits exits quietly when it wakes; the newer one keeps the page waiting', async () => {
    const tab = startTab({ session: [429, 429, 429, 429, 429] });
    void tab.state().checkSession();
    await tab.advance(1000);
    // Another tab refreshed: its pair is the same member's. Adopted, and asked again (what the storage listener does).
    tab.storage.set('rsn_tokens', JSON.stringify({ access: token(ME, 50), refresh: 'refresh-50' }));
    tab.state().adoptStoredTokens();
    const newer = tab.state().checkSession();
    await tab.advance(0);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 1000]);
    // The first check's wait would have ended at 2000: nothing of it is left.
    await tab.advance(1000);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.state().isLoading).toBe(true);
    expect(tab.state().sessionRetrying).toBe(true);
    expect(tab.pendingWaits()).toBe(1);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 1000]);
    await tab.advance(2000 + 5000 + 10000 + 20000);
    await newer;
    expect(tab.reads().map((r) => r.at)).toEqual([0, 1000, 3000, 8000, 18000, 38000]);
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.sentToSignIn).toEqual([]);
  });

  it('another tab\'s refresh of the same member, while this one waits with no member yet, does not end the wait', async () => {
    const tab = startTab({ session: [429, 429, 429] });
    const checking = tab.state().checkSession();
    await tab.advance(1000);
    const fresh = JSON.stringify({ access: token(ME, 60), refresh: 'refresh-60' });
    tab.storage.set('rsn_tokens', fresh);
    tab.fireStorage('rsn_tokens', fresh);
    await tab.advance(1000);
    expect(tab.sentToSignIn).toEqual([]);
    expect(tab.state().isLoading).toBe(true);
    await tab.advance(5000 + 10000);
    await checking;
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 2000, 7000, 17000]);
  });

  it('another member signing in in another tab while this one waits is followed: the page loads as that member', async () => {
    const tab = startTab({ session: [429] });
    void tab.state().checkSession();
    await tab.advance(1000);
    const theirs = JSON.stringify({ access: token(OTHER, 70), refresh: 'refresh-70' });
    tab.storage.set('rsn_tokens', theirs);
    tab.fireStorage('rsn_tokens', theirs);
    await tab.advance(0);
    expect(tab.state().user?.id).toBe(OTHER);
    expect(tab.state().isLoading).toBe(false);
    expect(tab.sentToSignIn).toEqual([]);
    await tab.advance(60_000);
    expect(tab.reads()).toHaveLength(2);
  });
});

describe('the wait itself', () => {
  it('asks exactly as often as the waits say over two minutes of 429s: 2, 5, 10, 20, then every 30 seconds', async () => {
    const tab = startTab({ session: Array(20).fill(429) });
    void tab.state().checkSession();
    await tab.advance(120_000);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 2000, 7000, 17000, 37000, 67000, 97000]);
    expect(tab.waits).toEqual([2000, 5000, 10000, 20000, 30000, 30000, 30000]);
    expect(tab.pendingWaits()).toBe(1);
    expect(tab.sentToSignIn).toEqual([]);
  });

  it.each([
    ['as low as four fifths', 0, [1600, 4000, 8000, 16000, 24000]],
    ['higher, at eleven tenths', 0.75, [2200, 5500, 11000, 22000, 33000]],
  ] as Array<[string, number, number[]]>)('each wait is moved by up to a fifth either way: %s', async (_label, random, expected) => {
    const tab = startTab({ session: [429, 429, 429, 429, 429] }, { random });
    const checking = tab.state().checkSession();
    await tab.advance(120_000);
    await checking;
    expect(tab.waits).toEqual(expected);
  });

  it('Retry-After, when it can be read, is waited exactly, with no jitter', async () => {
    const tab = startTab({ session: [{ status: 429, headers: { 'retry-after': '7' } }] }, { random: 0 });
    const checking = tab.state().checkSession();
    await tab.advance(7000);
    await checking;
    expect(tab.waits).toEqual([7000]);
  });
});

describe('finding 6: nothing is sent once the session has ended while the check waited', () => {
  it('signed out in this tab while it waits: no read after the sign-out, and the page stops waiting', async () => {
    const tab = startTab({ session: Array(20).fill(429) });
    void tab.state().checkSession();
    await tab.advance(1000);
    await tab.state().logout();
    await tab.advance(120_000);
    expect(tab.sent.map((r) => `${r.at} ${r.method} ${r.url}`)).toEqual(['0 GET /auth/session', '1000 POST /auth/logout']);
    expect(tab.state().sessionRetrying).toBe(false);
    expect(tab.state().isLoading).toBe(false);
    expect(tab.pendingWaits()).toBe(0);
  });

  it('signed out in another tab while it waits: no read after it, and the page stops waiting', async () => {
    const tab = startTab({ session: Array(20).fill(429) });
    void tab.state().checkSession();
    await tab.advance(1000);
    tab.storage.delete('rsn_tokens');
    tab.fireStorage('rsn_tokens', null);
    await tab.advance(120_000);
    expect(tab.reads().map((r) => r.at)).toEqual([0]);
    expect(tab.state().sessionRetrying).toBe(false);
    expect(tab.state().isLoading).toBe(false);
  });
});

describe('fix round 2: an answer that lands after the session ended is not put in place', () => {
  it('signed out while a read is on its way, the read then answered 200: the member stays signed out', async () => {
    const tab = startTab({ session: [429] });
    const checking = tab.state().checkSession();
    await tab.advance(0); // 429, waiting 2 seconds
    tab.holdSessionReads();
    await tab.advance(2000); // the second read is sent, and the server has not answered yet
    expect(tab.reads().map((r) => r.at)).toEqual([0, 2000]);
    await tab.state().logout();
    tab.answerHeldReads(); // 200, for the session that has just ended
    await tab.advance(0);
    await checking;
    expect(tab.state().user).toBeNull();
    expect(tab.state().isAuthenticated).toBe(false);
    expect(tab.state().accessToken).toBeNull();
    expect(tab.state().isLoading).toBe(false);
    expect(tab.state().sessionRetrying).toBe(false);
    expect(tab.tokensKept()).toBe(false);
    await tab.advance(60_000);
    expect(tab.reads()).toHaveLength(2);
  });
});

describe('finding 4: Try again', () => {
  it('asks at once, starts the waits again from the first, and leaves no other wait behind', async () => {
    const tab = startTab({ session: Array(20).fill(429) });
    void tab.state().checkSession();
    await tab.advance(2000 + 5000); // reads at 0, 2000, 7000; now waiting 10 seconds
    let answered = false;
    void tab.state().retrySessionNow().then(() => { answered = true; });
    await tab.advance(0);
    expect(answered).toBe(true);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 2000, 7000, 7000]);
    expect(tab.waits.slice(-1)).toEqual([2000]);
    expect(tab.pendingWaits()).toBe(1);
    // The old wait (due at 17000) is gone: the reads follow the new waits only.
    await tab.advance(10_000);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 2000, 7000, 7000, 9000, 14000]);
    expect(tab.sentToSignIn).toEqual([]);
  });

  it('pressed twice at once, asks once', async () => {
    const tab = startTab({ session: Array(20).fill(429) });
    void tab.state().checkSession();
    await tab.advance(1000);
    void tab.state().retrySessionNow();
    void tab.state().retrySessionNow();
    await tab.advance(0);
    expect(tab.reads().map((r) => r.at)).toEqual([0, 1000]);
    expect(tab.pendingWaits()).toBe(1);
  });

  it('lands the page when the answer comes back', async () => {
    const tab = startTab({ session: [429, 429, 429] });
    void tab.state().checkSession();
    await tab.advance(2000 + 5000);
    await tab.state().retrySessionNow();
    await tab.advance(0);
    expect(tab.state().user?.id).toBe(ME);
    expect(tab.state().isLoading).toBe(false);
    expect(tab.state().sessionRetrying).toBe(false);
    expect(tab.pendingWaits()).toBe(0);
  });

  it('does nothing when no check is waiting', async () => {
    const tab = startTab({});
    await tab.state().checkSession();
    await tab.state().retrySessionNow();
    await tab.advance(60_000);
    expect(tab.reads()).toHaveLength(1);
  });
});

describe('finding 4: the waiting screen offers a way out', () => {
  type ChoicesProps = { trying: boolean; signingOut: boolean; onTryAgain: () => void; onSignOut: () => void };
  function renderChoices(props: Partial<ChoicesProps>): string {
    const mod = loadClientModule('components/layout/SessionRetrying.tsx', {
      '@/stores/authStore': { useAuthStore: () => undefined },
    });
    const Choices = mod.SessionRetryingChoices as (p: ChoicesProps) => unknown;
    return renderToStaticMarkup(createElement(Choices as never, { trying: false, signingOut: false, onTryAgain: () => undefined, onSignOut: () => undefined, ...props }));
  }

  it('two buttons, Try again and Sign out, each at least 44px tall', () => {
    const html = renderChoices({});
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('data-testid="session-try-again"');
    expect(buttons[0]).toContain('>Try again<');
    expect(buttons[1]).toContain('data-testid="session-sign-out"');
    expect(buttons[1]).toContain('>Sign out<');
    for (const b of buttons) expect(b).toMatch(/min-h-\[(44|48)px\]/);
    expect(buttons[0]).not.toContain('disabled=""');
  });

  it('Try again shows that it is trying, and cannot be pressed again meanwhile', () => {
    const html = renderChoices({ trying: true });
    const tryAgain = (html.match(/<button[^>]*data-testid="session-try-again"[^>]*>.*?<\/button>/) ?? [''])[0];
    expect(tryAgain).toContain('disabled=""');
    expect(tryAgain).toContain('animate-spin');
    expect(tryAgain).toContain('aria-busy="true"');
  });

  it('Sign out shows that it is signing out, and neither button can be pressed meanwhile', () => {
    const html = renderChoices({ signingOut: true });
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons.every((b) => b.includes('disabled=""'))).toBe(true);
    expect(buttons[1]).toContain('animate-spin');
  });

  it('the screen says it is retrying, and offers the buttons only after about 20 seconds', () => {
    const mod = loadClientModule('components/layout/SessionRetrying.tsx', {
      '@/stores/authStore': { useAuthStore: () => undefined },
    });
    expect(mod.OFFER_CHOICES_AFTER_MS).toBe(20_000);
    const Screen = mod.default as () => unknown;
    const html = renderToStaticMarkup(createElement(Screen as never));
    expect(html).toContain('data-testid="session-retrying"');
    expect(html).toContain('Connection lost, retrying…');
    expect(html).not.toContain('<button');
  });
});
