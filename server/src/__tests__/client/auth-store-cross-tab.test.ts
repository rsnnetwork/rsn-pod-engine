// server/src/__tests__/client/auth-store-cross-tab.test.ts
// A tab must not act as another member without saying so (REASON milestone 1, fix wave F1).
//
// The auth store's `storage` listener used to ignore a sign-in made in another tab while this tab was signed in. The
// tokens in storage then belonged to the other member, and the next refresh here (the freshest refresh token in storage
// is what refreshAccessToken uses) made this tab act as that member under the first member's name and cached data: a
// Meet, a Save, a Pass or an outcome was written as the wrong member, and the other member's private "you are looking
// for" appeared under the first member's name.
//
// EXECUTED, not read: the real authStore.ts is transpiled and run against a fake window and a fake localStorage, with the
// real zustand and the real query cache (client/src/lib/queryClient.ts). Only the HTTP client is replaced: its session
// answer is the member whose token the store holds when the request is made, which is what the server does.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { clearCache, queryClient } from '../../../../client/src/lib/queryClient';

interface Pair { access: string; refresh: string }
interface State {
  user: { id: string } | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  checkSession: () => Promise<void>;
}

// What the server signs: header.payload.signature, the payload being base64url JSON. The client never verifies it.
const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (sub: string, claims: Record<string, unknown> = {}) =>
  [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(JSON.stringify({ sub, exp: 4102444800, ...claims })), 'signature'].join('.');
// A payload whose base64url text has a '-' or a '_' in it (a name with a "?" in it will do). Plain atob cannot read those.
const urlSafeToken = (sub: string, claims: Record<string, unknown> = {}) => {
  for (let i = 3; i < 60; i++) {
    const t = token(sub, { ...claims, displayName: `Who${'?'.repeat(i)}` });
    if (/[-_]/.test(t.split('.')[1])) return t;
  }
  throw new Error('no payload with url-safe characters found');
};
const subOf = (t: string | null) => {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).sub as string; } catch { return 'unreadable'; }
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The real store, started the way a tab starts: reading whatever tokens storage holds. */
function startTab(initial: Pair | null) {
  const storage = new Map<string, string>();
  const writeTokens = (t: Pair) => {
    storage.set('rsn_tokens', JSON.stringify(t));
    storage.set('rsn_access', t.access);
    storage.set('rsn_refresh', t.refresh);
  };
  if (initial) writeTokens(initial);
  // The tab's OWN writes go through here and are counted; what another tab writes goes straight into `storage`.
  let ownWrites = 0;
  const localStorage = {
    getItem: (k: string) => (storage.has(k) ? (storage.get(k) as string) : null),
    setItem: (k: string, v: string) => { ownWrites += 1; storage.set(k, String(v)); },
    removeItem: (k: string) => { ownWrites += 1; storage.delete(k); },
  };
  const listeners: Array<(e: { key: string | null; newValue: string | null }) => void> = [];
  const requests: string[] = [];
  let tokenNow: () => string | null = () => null;
  const api = {
    get: async (url: string) => {
      const sub = subOf(tokenNow());
      requests.push(`GET ${url} as ${sub}`);
      return { data: { data: { user: { id: sub } } } };
    },
    post: async (url: string) => { requests.push(`POST ${url}`); return { data: { data: {} } }; },
  };
  const sandbox = {
    window: { addEventListener: (type: string, fn: (e: { key: string | null; newValue: string | null }) => void) => { if (type === 'storage') listeners.push(fn); } },
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage,
    // Node's own atob is as strict as a browser's: it throws on a "-" or a "_" (Buffer's base64 decoder would not).
    atob: globalThis.atob,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };

  const source = fs.readFileSync(path.join(__dirname, '../../../../client/src/stores/authStore.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (id: string): unknown => {
    if (id === '@/lib/api') return { __esModule: true, default: api };
    if (id === '@/lib/queryClient') return require('../../../../client/src/lib/queryClient');
    return require(id); // zustand
  };
  const run = vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`, sandbox) as (m: unknown, e: unknown, r: unknown) => void;
  run(mod, mod.exports, load);
  const store = mod.exports.useAuthStore as { getState: () => State };
  tokenNow = () => store.getState().accessToken;

  const fire = (key: string | null, newValue: string | null) => listeners.forEach((fn) => fn({ key, newValue }));
  return {
    store,
    storage,
    requests,
    sessionChecks: () => requests.filter((r) => r.startsWith('GET /auth/session')).length,
    ownWrites: () => ownWrites,
    /** What another tab does when it signs in: writeStoredTokens writes the canonical key, then the two legacy mirrors. */
    otherTabSignsIn: (t: Pair) => {
      writeTokens(t);
      fire('rsn_tokens', storage.get('rsn_tokens') as string);
      fire('rsn_access', t.access);
      fire('rsn_refresh', t.refresh);
    },
    /** The ping a verify tab writes once it is done. */
    otherTabPings: () => fire('rsn_auth_completed_at', '1700000000000'),
    otherTabSignsOut: () => {
      ['rsn_tokens', 'rsn_access', 'rsn_refresh'].forEach((k) => storage.delete(k));
      fire('rsn_tokens', null);
    },
  };
}

const A = 'member-a';
const B = 'member-b';
const forYou = ['reason', 'for-you'];
const seedCache = () => queryClient.setQueryData(forYou, { youAreLookingFor: "A's private want" });

/** A tab that has finished its session check as `sub`. */
async function signedInAs(sub: string, access = token(sub)) {
  const tab = startTab({ access, refresh: `refresh-${sub}` });
  await tab.store.getState().checkSession();
  expect(tab.store.getState().user?.id).toBe(sub);
  return tab;
}

beforeEach(() => clearCache());
afterAll(() => clearCache());

describe('another tab signs in as a DIFFERENT member while this tab is signed in', () => {
  it('this tab adopts the new tokens and loads that member, so it shows and acts as the one member; the first member\'s cache is emptied', async () => {
    const tab = await signedInAs(A);
    seedCache();
    const checks = tab.sessionChecks();
    const theirs = { access: token(B), refresh: 'refresh-member-b' };

    tab.otherTabSignsIn(theirs);
    await settle();

    const now = tab.store.getState();
    expect(now.accessToken).toBe(theirs.access);
    expect(now.refreshToken).toBe(theirs.refresh);
    expect(now.isAuthenticated).toBe(true);
    // The session was loaded with the new token, and its answer is the new member: name, data and actions agree.
    expect(now.user?.id).toBe(B);
    expect(tab.requests[tab.requests.length - 1]).toBe(`GET /auth/session as ${B}`);
    expect(tab.sessionChecks()).toBe(checks + 1);
    // Whose cache it is was settled by that session check: A's data is gone before any page of B's can read it.
    expect(queryClient.getQueryData(forYou)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('adopting only reads storage: this tab writes nothing back (writing back is what corrupted the pair on 7 Sep 2026)', async () => {
    const tab = await signedInAs(A);
    const theirs = { access: token(B), refresh: 'refresh-member-b' };
    expect(tab.ownWrites()).toBe(0);
    tab.otherTabSignsIn(theirs);
    await settle();
    expect(tab.store.getState().user?.id).toBe(B); // it did adopt...
    expect(tab.ownWrites()).toBe(0); // ...and wrote nothing
    expect(JSON.parse(tab.storage.get('rsn_tokens') as string)).toEqual(theirs);
  });

  it('asks the server once per sign-in: the legacy mirror keys and the completion ping that follow the tokens change nothing, even while the first check is still on its way', async () => {
    const tab = await signedInAs(A);
    const checks = tab.sessionChecks();
    tab.otherTabSignsIn({ access: token(B), refresh: 'refresh-member-b' });
    // The ping is written when the other tab is done, which can be before this tab's check has answered: the member
    // shown is still A then, and the stored tokens are B's.
    expect(tab.store.getState().user?.id).toBe(A);
    tab.otherTabPings();
    await settle();
    tab.otherTabPings();
    await settle();
    expect(tab.sessionChecks()).toBe(checks + 1);
    expect(tab.store.getState().user?.id).toBe(B);
  });

  it('reads whose tokens they are from a payload that plain atob cannot read ("-" and "_" in the base64url text)', async () => {
    const tab = await signedInAs(A);
    const theirs = { access: urlSafeToken(B), refresh: 'refresh-member-b' };
    expect(theirs.access.split('.')[1]).toMatch(/[-_]/);
    tab.otherTabSignsIn(theirs);
    await settle();
    expect(tab.store.getState().accessToken).toBe(theirs.access);
    expect(tab.store.getState().user?.id).toBe(B);
  });

  it('follows tokens it cannot read too: when in doubt it adopts and lets the session check say who they are', async () => {
    const tab = await signedInAs(A);
    const checks = tab.sessionChecks();
    tab.otherTabSignsIn({ access: 'not-a-jwt', refresh: 'refresh-x' });
    await settle();
    expect(tab.store.getState().accessToken).toBe('not-a-jwt');
    expect(tab.sessionChecks()).toBe(checks + 1);
  });

  it('follows them while its own session check has not finished (it does not know its member yet)', async () => {
    const tab = startTab({ access: token(A), refresh: 'refresh-member-a' });
    expect(tab.store.getState().user).toBeNull();
    expect(tab.store.getState().isAuthenticated).toBe(true);
    tab.otherTabSignsIn({ access: token(B), refresh: 'refresh-member-b' });
    await settle();
    expect(tab.store.getState().accessToken).toBe(token(B));
    expect(tab.store.getState().user?.id).toBe(B);
  });
});

describe('another tab signs in as the SAME member (a token refresh there)', () => {
  it('changes nothing here: the tokens, the member, the cache and the number of session checks stay as they were', async () => {
    const tab = await signedInAs(A);
    seedCache();
    const before = tab.store.getState();
    const checks = tab.sessionChecks();

    tab.otherTabSignsIn({ access: token(A, { iat: 2 }), refresh: 'refresh-member-a-2' });
    await settle();

    const now = tab.store.getState();
    expect(now.accessToken).toBe(before.accessToken);
    expect(now.refreshToken).toBe(before.refreshToken);
    expect(now.user?.id).toBe(A);
    expect(tab.sessionChecks()).toBe(checks);
    expect(queryClient.getQueryData(forYou)).toEqual({ youAreLookingFor: "A's private want" });
  });

  it('still changes nothing when the payload is one plain atob cannot read: the member is read properly, not guessed', async () => {
    const tab = await signedInAs(A, urlSafeToken(A));
    seedCache();
    const before = tab.store.getState().accessToken;
    const checks = tab.sessionChecks();
    tab.otherTabSignsIn({ access: urlSafeToken(A, { iat: 2 }), refresh: 'refresh-member-a-2' });
    await settle();
    expect(tab.store.getState().accessToken).toBe(before);
    expect(tab.sessionChecks()).toBe(checks);
    expect(queryClient.getQueryData(forYou)).toEqual({ youAreLookingFor: "A's private want" });
  });
});

describe('a tab that is signed out, and a sign-out in another tab: unchanged', () => {
  it('a signed-out tab follows another tab\'s sign-in, as before (the tokens event)', async () => {
    const tab = startTab(null);
    await tab.store.getState().checkSession();
    expect(tab.store.getState().isAuthenticated).toBe(false);
    tab.otherTabSignsIn({ access: token(A), refresh: 'refresh-member-a' });
    await settle();
    expect(tab.store.getState().isAuthenticated).toBe(true);
    expect(tab.store.getState().user?.id).toBe(A);
    expect(tab.store.getState().accessToken).toBe(token(A));
  });

  it('a signed-out tab follows the completion ping too, as before (the login page\'s own tab)', async () => {
    const tab = startTab(null);
    await tab.store.getState().checkSession();
    // The verify tab wrote its tokens, and this tab only heard the ping.
    ['rsn_tokens', 'rsn_access', 'rsn_refresh'].forEach((k, i) => tab.storage.set(k, [JSON.stringify({ access: token(A), refresh: 'refresh-member-a' }), token(A), 'refresh-member-a'][i]));
    tab.otherTabPings();
    await settle();
    expect(tab.store.getState().user?.id).toBe(A);
  });

  it('a sign-out in another tab still signs this tab out and empties its cache', async () => {
    const tab = await signedInAs(A);
    seedCache();
    tab.otherTabSignsOut();
    await settle();
    const now = tab.store.getState();
    expect(now.isAuthenticated).toBe(false);
    expect(now.user).toBeNull();
    expect(now.accessToken).toBeNull();
    expect(queryClient.getQueryData(forYou)).toBeUndefined();
  });
});
