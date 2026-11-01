// server/src/__tests__/client/f12-session-follows-server.test.ts
// Final sweep F1 and F2 (2 Nov 2026): two reads that did not follow the server.
//
// F1: a member with two devices. Device 2 is held at the onboarding gate; they finish on device 1 (or add their city).
// The server tells every screen of theirs (user:<id>), but the gate reads the session in the auth store, which only the
// device that confirmed re-read, so device 2 sent every move back to onboarding until it was loaded again. Now the
// session is a tagged read: user:<id> (and a reconnect after a gap) re-reads GET /auth/session into the auth store.
//
// F2: an admin with the member's inspector open did not see the new onboarding answers ("realtime: skip"). The server
// now sends every admin admin:users when a member's answers or inspected profile fields change, and the inspector's
// onboarding read declares it.
//
// EXECUTED, not read: the real authStore.ts is transpiled and run against a fake window and storage with the real
// zustand, beside a real query cache, the real session-read options, the real entity-tag invalidation and the real
// gate rule. Only the HTTP client is replaced: it answers the session the "server" holds at the moment of the request.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { sessionReadOptions } from '../../../../client/src/realtime/session-read';
import { invalidateEntities, subscribeEntitySync, type EntitySignals } from '../../../../client/src/realtime/invalidate-entities';
import { onboardingDue } from '../../../../client/src/components/layout/onboarding-gate';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

type SessionUser = { id: string; onboardingStatus?: string; onboardingVersion?: number | null; location?: string | null; displayName?: string };
interface State {
  user: SessionUser | null;
  isAuthenticated: boolean;
  checkSession: () => Promise<void>;
  rereadSession: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (sub: string) => [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(JSON.stringify({ sub, exp: 4102444800 })), 'sig'].join('.');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One device: the real store, signed in as `memberId`, whose session answers are whatever `server.session` holds then. */
async function device(memberId: string, server: { session: SessionUser }) {
  const storage = new Map<string, string>([['rsn_tokens', JSON.stringify({ access: token(memberId), refresh: `r-${memberId}` })]]);
  const requests: string[] = [];
  let pending: Array<() => void> = [];
  let holdAnswers = false;
  const api = {
    get: async (url: string) => {
      requests.push(`GET ${url}`);
      if (holdAnswers) await new Promise<void>((resolve) => pending.push(resolve));
      return { data: { data: { user: { ...server.session } } } };
    },
    post: async (url: string) => { requests.push(`POST ${url}`); return { data: { data: {} } }; },
  };
  const sandbox = {
    window: { addEventListener: () => undefined },
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? (storage.get(k) as string) : null),
      setItem: (k: string, v: string) => { storage.set(k, String(v)); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    atob: globalThis.atob,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  const { outputText } = ts.transpileModule(read('stores/authStore.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (id: string): unknown => {
    if (id === '@/lib/api') return { __esModule: true, default: api };
    if (id === '@/lib/queryClient') return require('../../../../client/src/lib/queryClient');
    return require(id); // zustand
  };
  (vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`, sandbox) as (m: unknown, e: unknown, r: unknown) => void)(mod, mod.exports, load);
  const store = mod.exports.useAuthStore as { getState: () => State };
  await store.getState().checkSession();

  // What the app mounts (useSessionFollowsServer): the session as a read tagged with the member's own user:<id>.
  const qc = new QueryClient();
  const observer = new QueryObserver(qc, {
    ...sessionReadOptions(memberId, () => store.getState().rereadSession(), store.getState().user),
    meta: { entities: [`user:${memberId}`] },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    store, qc, requests,
    sessionReads: () => requests.filter((r) => r === 'GET /auth/session').length,
    hold: () => { holdAnswers = true; },
    release: () => { holdAnswers = false; pending.forEach((go) => go()); pending = []; },
    close: () => { unsubscribe(); qc.clear(); },
  };
}

const OLD: SessionUser = { id: 'una', onboardingStatus: 'completed', onboardingVersion: null, location: null, displayName: 'Una' };
const DONE: SessionUser = { id: 'una', onboardingStatus: 'completed', onboardingVersion: 2, location: 'Copenhagen, Denmark', displayName: 'Una' };

describe('F1: the session follows the server on every device of the member', () => {
  it('device 2, held at the gate, is let through once user:<id> says the member finished on device 1', async () => {
    const server = { session: { ...OLD } };
    const two = await device('una', server);
    expect(onboardingDue(two.store.getState().user)).toBe('flow');
    const readsAtStart = two.sessionReads();

    server.session = { ...DONE }; // device 1 confirmed: the server sends user:una to every screen of hers
    await invalidateEntities(two.qc, ['user:una']);
    await settle();

    expect(two.sessionReads()).toBe(readsAtStart + 1);
    expect(two.store.getState().user).toMatchObject({ onboardingVersion: 2, location: 'Copenhagen, Denmark' });
    expect(onboardingDue(two.store.getState().user)).toBeNull();
    two.close();
  });

  it('adding the city on device 1 lets the location gate on device 2 go too', async () => {
    const server = { session: { ...DONE, location: 'USA' } };
    const two = await device('una', server);
    expect(onboardingDue(two.store.getState().user)).toBe('location');
    server.session = { ...DONE, location: 'Lisbon, Portugal' };
    await invalidateEntities(two.qc, ['user:una']);
    await settle();
    expect(onboardingDue(two.store.getState().user)).toBeNull();
    two.close();
  });

  it('opening the app costs no extra session read: the read starts from the session the boot check loaded', async () => {
    const two = await device('una', { session: { ...DONE } });
    expect(two.sessionReads()).toBe(1); // the boot check's own, nothing more
    two.close();
  });

  it('another member\'s tags, and the member\'s own sub-tags, do not re-read it', async () => {
    const two = await device('una', { session: { ...DONE } });
    await invalidateEntities(two.qc, ['user:bo', 'user:una:dms', 'user:una:notifications', 'admin:users']);
    await settle();
    expect(two.sessionReads()).toBe(1);
    two.close();
  });

  it('an answer that changes nothing leaves the store\'s user as it was, so no screen redraws (a form being typed in is not reset)', async () => {
    const server = { session: { ...DONE } };
    const two = await device('una', server);
    const before = two.store.getState().user;
    await invalidateEntities(two.qc, ['user:una']);
    await settle();
    expect(two.sessionReads()).toBe(2);
    expect(two.store.getState().user).toBe(before);
    two.close();
  });

  it('a session that answers as another member is not put in place: following a sign-in in another tab is the storage listener\'s job', async () => {
    const server = { session: { ...DONE } };
    const two = await device('una', server);
    server.session = { ...DONE, id: 'bo', displayName: 'Bo' };
    await invalidateEntities(two.qc, ['user:una']);
    await settle();
    expect(two.store.getState().user).toMatchObject({ id: 'una', displayName: 'Una' });
    two.close();
  });

  it('a device signed out while the read was on its way stays signed out', async () => {
    const server = { session: { ...OLD } };
    const two = await device('una', server);
    server.session = { ...DONE };
    two.hold();
    const read = invalidateEntities(two.qc, ['user:una']);
    await settle();
    await two.store.getState().logout();
    two.release();
    await read;
    await settle();
    expect(two.store.getState().user).toBeNull();
    expect(two.store.getState().isAuthenticated).toBe(false);
    two.close();
  });

  it('a reconnect after a gap re-reads it, so a finish missed while the socket was down still lets the gate go', async () => {
    const server = { session: { ...OLD } };
    const two = await device('una', server);
    server.session = { ...DONE }; // sent while device 2's socket was down: it never heard user:una
    const socket = new EventEmitter() as EventEmitter & EntitySignals;
    const stop = subscribeEntitySync(socket, two.qc, { now: () => Date.now() + 10_000 });
    socket.emit('connect');
    await settle();
    await settle();
    expect(onboardingDue(two.store.getState().user)).toBeNull();
    stop();
    two.close();
  });
});

describe('F1: wired into the app', () => {
  const hook = () => (fs.existsSync(path.join(CLIENT, 'realtime/useSessionFollowsServer.ts')) ? read('realtime/useSessionFollowsServer.ts') : '');
  const app = () => read('App.tsx');

  it('the app mounts the session read once, beside the entity-tag handler', () => {
    expect(app()).toMatch(/import \{ useSessionFollowsServer \} from '@\/realtime\/useSessionFollowsServer';/);
    expect(app().match(/useSessionFollowsServer\(\);/g)).toHaveLength(1);
    expect(app().indexOf('useSessionFollowsServer();')).toBeGreaterThan(app().indexOf('useEntityChangedHandler();'));
  });

  it('the read is tagged with the member\'s own user:<id>, runs only once the session is checked, and re-reads through the store', () => {
    expect(hook()).toMatch(/meta: \{ entities: memberId \? \[E\.user\(memberId\)\] : \[\] \}/);
    expect(hook()).toMatch(/enabled: !!memberId/);
    expect(hook()).toMatch(/s\.isAuthenticated && s\.isSessionChecked/);
    expect(hook()).toMatch(/s\.rereadSession/);
  });

  it('the read never has a key the realtime guard lets off, and starts fresh from the boot check (no refetch on mount or focus)', () => {
    const options = sessionReadOptions('m-1', async () => null, { id: 'm-1' });
    expect(options.queryKey).toEqual(['auth-session', 'm-1']);
    expect(options.staleTime).toBe(Infinity);
    expect(options.initialData).toEqual({ id: 'm-1' });
    expect(typeof options.initialDataUpdatedAt).toBe('number');
  });
});

describe('F2: the admin inspector\'s onboarding card follows the member\'s answers', () => {
  const page = read('features/admin/AdminUserInspectorPage.tsx');
  const query = page.slice(page.indexOf('const onboardingQuery = useQuery({'), page.indexOf('const profileQuery'));

  it('declares admin:users, which every admin is sent when a member confirms an onboarding or saves their profile', () => {
    expect(query).toMatch(/meta: \{ entities: id \? \[E\.adminUsers, E\.user\(id\)\] : \[E\.adminUsers\] \}/);
  });

  it('is no longer opted out of realtime', () => {
    const before = page.slice(Math.max(0, page.indexOf('const onboardingQuery = useQuery({') - 400), page.indexOf('const onboardingQuery = useQuery({'));
    expect(before).not.toMatch(/realtime: skip/);
  });
});
