// ─── Tagged reads are refreshed when the socket connects, the first time and after a gap (P1 item 17 + X1) ─────────
//
// A socket that was down heard none of the entity:changed sent meanwhile, and neither did a freshly opened tab between
// its first reads and its socket's first connect (seen on the preview: a message landing in that window left the new
// tab's count at 1). So on a connect, the first included, the reads that declare meta.entities are refreshed, through
// the same rule entity:changed uses. The screens' own "refetch on connect" listeners are then redundant and went.
//
// Fix round 1 (review of T16): the refresh must not storm. A flapping phone socket reconnects every second or so, and
// every tagged read (every loaded page of an infinite one) counts against the 60 and 120 reads a minute. So:
//   - connects are coalesced: the first in a window refreshes at once, any more within the window cause ONE more
//     refresh when the window ends;
//   - a read still on its way is never cancelled, and a read that answered within the last moments is not read again
//     (a page load's first reads, or the focus refetch of a phone that came back, are not doubled).
//
// Final fix wave CX1 (2 Nov 2026; T19's Script E 5b in WebKit): "answered within the last moments" is not "answered
// after the socket was listening". A read that STARTED before the connect can carry what the server held before a
// change whose entity:changed went out before this socket was in its rooms, and land after it; the resync then skipped
// it as just read and the page stayed stale until a reload (CLAUDE.md section 3, the late-joiner race). So a connect
// now reads again every tagged read that started before it: one still on its way is sent again (or, a first read with
// no data yet, read again the moment it lands); only a read that STARTED after the connect is left alone. The
// coalescing window stays.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { QueryClient } from '@tanstack/query-core';
import { QueryObserver } from '@tanstack/query-core';
import {
  CONNECT_RESYNC_WINDOW_MS, subscribeEntitySync, type EntitySignals,
} from '../../../../client/src/realtime/invalidate-entities';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

async function cacheWith(): Promise<QueryClient> {
  const qc = new QueryClient();
  await qc.fetchQuery({ queryKey: ['dm-unread-count'], queryFn: () => 1, meta: { entities: ['user:b:dms'] } });
  await qc.fetchQuery({ queryKey: ['pod', 'p1'], queryFn: () => ({}), meta: { entities: ['pod:p1'] } });
  await qc.fetchQuery({ queryKey: ['empty-tags'], queryFn: () => 0, meta: { entities: [] } });
  await qc.fetchQuery({ queryKey: ['untagged'], queryFn: () => 0 });
  return qc;
}
const invalidated = (qc: QueryClient, key: unknown[]) => qc.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated;
const fakeSocket = () => new EventEmitter() as EventEmitter & EntitySignals;
const flush = () => new Promise((r) => setImmediate(r));

describe('subscribeEntitySync: a connect refreshes what may have been missed, without storming', () => {
  it('the window is a few seconds', () => {
    expect(CONNECT_RESYNC_WINDOW_MS).toBe(5000);
  });

  it('the socket\'s FIRST connect refreshes every tagged read answered before the last moments (a new tab missed what came before it)', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    const later = Date.now() + 10_000;
    subscribeEntitySync(socket, qc, { now: () => later });
    socket.emit('connect');
    await flush();
    expect(invalidated(qc, ['dm-unread-count'])).toBe(true);
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['untagged'])).toBe(false);
    qc.clear();
  });

  // CX1: the exact order of T19's Script E 5b. The page's read starts, the server answers what it holds, the change
  // happens (its entity:changed goes nowhere: the socket is not in its rooms yet), the old answer lands, and the socket
  // connects within 2 s of that landing. The read is read again, and the page shows the change.
  it('a read that started before the connect is read again, even if its (old) answer landed just before it', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    // The cache stamps an answer with the real clock, so the test's clock is the real one, moved by hand.
    const landing = Date.now();
    let t = landing - 3000;       // the page's read starts
    subscribeEntitySync(socket, qc, { now: () => t });
    let server = 'old time';
    let calls = 0;
    let deliver: (v: string) => void = () => {};
    const observer = new QueryObserver(qc, {
      queryKey: ['meeting', 'm1'], meta: { entities: ['meeting:m1'] },
      queryFn: () => { calls += 1; const answer = server; return calls === 1 ? new Promise<string>((r) => { deliver = () => r(answer); }) : Promise.resolve(answer); },
    });
    const off = observer.subscribe(() => {});
    await flush();                // the server answers the first read with what it holds
    server = 'new time';          // the move happens; its entity:changed is lost
    deliver('old time');          // the old answer lands, now
    await flush();
    expect(qc.getQueryData(['meeting', 'm1'])).toBe('old time');
    t = landing + 1300;           // the socket connects, 1.3 s after the landing
    socket.emit('connect');
    await flush(); await flush();
    expect(calls).toBe(2);
    expect(qc.getQueryData(['meeting', 'm1'])).toBe('new time');
    off();
    qc.clear();
  });

  // A first read (no data yet) is read again the moment it lands: cancelling it would fail whoever awaits it.
  it('a read that started before the connect and is still on its way is read again, so the page ends on an answer from after it', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = 2_000_000;
    subscribeEntitySync(socket, qc, { now: () => t });
    let server = 'old';
    let calls = 0;
    const pending: Array<(v: string) => void> = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['slow'], meta: { entities: ['pod:p1'] },
      queryFn: () => { calls += 1; const answer = server; return new Promise<string>((r) => { pending.push(() => r(answer)); }); },
    });
    const off = observer.subscribe(() => {});
    await flush();
    server = 'new';
    t += 1000;
    socket.emit('connect');
    await flush();
    expect(calls).toBe(1);        // not cancelled: whoever awaits it still gets an answer
    pending[0]('');               // the old answer lands
    await flush(); await flush();
    expect(calls).toBe(2);        // and is read again at once
    pending[1]('');
    await flush(); await flush();
    expect(qc.getQueryData(['slow'])).toBe('new');
    off();
    qc.clear();
  });

  it('a refresh with data that started before the connect and is still on its way is sent again at once', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = 2_500_000;
    subscribeEntitySync(socket, qc, { now: () => t });
    let server = 'first';
    let calls = 0;
    const pending: Array<() => void> = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['refreshing'], meta: { entities: ['pod:p1'] },
      queryFn: () => {
        calls += 1;
        const answer = server;
        return calls === 1 ? Promise.resolve(answer) : new Promise<string>((r) => { pending.push(() => r(answer)); });
      },
    });
    const off = observer.subscribe(() => {});
    await flush();
    void observer.refetch();      // a refresh starts, before the socket connects
    await flush();
    server = 'after the change';
    t += 1000;
    socket.emit('connect');
    await flush();
    expect(calls).toBe(3);        // the refresh was sent again, not waited for
    for (const answer of pending) answer();
    await flush(); await flush();
    expect(qc.getQueryData(['refreshing'])).toBe('after the change');
    off();
    qc.clear();
  });

  it('a read that STARTED after the connect is never cancelled or read again: it is already from after it', async () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const socket = fakeSocket();
      let t = 3_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      socket.emit('connect');               // the first connect, before the read
      t += 1000;
      socket.emit('connect');               // a second connect in the window: answered when the window ends
      t += 500;
      let release: (v: number) => void = () => {};
      let calls = 0;
      const observer = new QueryObserver(qc, {
        queryKey: ['after'], meta: { entities: ['pod:p1'] },
        queryFn: () => { calls += 1; return new Promise<number>((r) => { release = r; }); },
      });
      const off = observer.subscribe(() => {});
      t += CONNECT_RESYNC_WINDOW_MS;
      jest.advanceTimersByTime(CONNECT_RESYNC_WINDOW_MS); // the window's one more resync runs, while the read is on its way
      expect(calls).toBe(1);
      release(7);
      await Promise.resolve();
      off();
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a burst of five connects refreshes once at once and once more when the window ends, never five times', async () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const spy = jest.spyOn(qc, 'invalidateQueries');
      const socket = fakeSocket();
      let t = 1_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      for (let i = 0; i < 5; i++) { socket.emit('connect'); t += 400; jest.advanceTimersByTime(400); }
      expect(spy).toHaveBeenCalledTimes(1);
      t += CONNECT_RESYNC_WINDOW_MS;
      jest.advanceTimersByTime(CONNECT_RESYNC_WINDOW_MS);
      expect(spy).toHaveBeenCalledTimes(2);
      // Quiet afterwards: no more.
      t += 20_000;
      jest.advanceTimersByTime(20_000);
      expect(spy).toHaveBeenCalledTimes(2);
      // A connect long after the window is answered at once again.
      socket.emit('connect');
      expect(spy).toHaveBeenCalledTimes(3);
      // Each resync re-sends a read on its way only when it started before the connect (the predicate leaves the others).
      for (const call of spy.mock.calls) expect(call[1]).toEqual({ cancelRefetch: true });
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a lone connect in a quiet window refreshes once, with no second refresh at its end', () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const spy = jest.spyOn(qc, 'invalidateQueries');
      const socket = fakeSocket();
      let t = 5_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      socket.emit('connect');
      t += 3 * CONNECT_RESYNC_WINDOW_MS;
      jest.advanceTimersByTime(3 * CONNECT_RESYNC_WINDOW_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  it('entity:changed refreshes exactly the reads that declare one of its tags, at once (never coalesced)', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    socket.emit('entity:changed', { entities: ['pod:p1'] });
    await flush();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['dm-unread-count'])).toBe(false);
    socket.emit('entity:changed', {});
    qc.clear();
  });

  it('unsubscribing takes both listeners off and drops a waiting refresh', () => {
    jest.useFakeTimers();
    try {
      const qc = new QueryClient();
      const spy = jest.spyOn(qc, 'invalidateQueries');
      const socket = fakeSocket();
      let t = 9_000_000;
      const off = subscribeEntitySync(socket, qc, { now: () => t });
      socket.emit('connect');
      socket.emit('connect');
      off();
      expect(socket.listenerCount('connect')).toBe(0);
      expect(socket.listenerCount('entity:changed')).toBe(0);
      t += CONNECT_RESYNC_WINDOW_MS;
      jest.advanceTimersByTime(CONNECT_RESYNC_WINDOW_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the app wires it once, and the screens no longer refetch on connect themselves', () => {
  it('useEntityChangedHandler subscribes through subscribeEntitySync and unsubscribes on unmount', () => {
    const src = read('realtime/useEntityChangedHandler.ts');
    expect(src).toMatch(/import \{ subscribeEntitySync \} from '\.\/invalidate-entities';/);
    expect(src).toMatch(/return subscribeEntitySync\(getSocket\(\), queryClient\);/);
  });

  it('the pod wall, the onboarding state and the call signals keep no connect refetch of their own', () => {
    expect(read('components/wall/Wall.tsx')).not.toMatch(/socket\.on\('connect'/);
    expect(read('features/onboarding/useOnboardingV2.ts')).not.toMatch(/socket\.on\('connect'/);
    expect(read('features/calls/useCallSignals.ts')).not.toMatch(/socket\.on\('connect'/);
  });
});

describe('the live event page leaves the app-wide connect listeners in place', () => {
  it('useSessionSocket removes only its own connect listener, never every one (it used to strip the resync)', () => {
    const live = read('hooks/useSessionSocket.ts');
    expect(live).not.toMatch(/socket\.off\('connect'\);/);
    expect(live).toMatch(/socket\.once\('connect', joinSession\);/);
    expect(live).toMatch(/socket\.off\('connect', joinSession\);/);
  });
});

describe('no screen removes another screen\'s socket listeners (review T16, fix round 1)', () => {
  it('no .off(...) in client/src is called with only an event name, and removeAllListeners only signs out', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(f.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        const rel = path.relative(CLIENT, p).split(path.sep).join('/');
        for (const m of src.matchAll(/\.off\(\s*(?:'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*\)/g)) offenders.push(`${rel}: ${m[0]}`);
        if (/removeAllListeners\(/.test(src) && rel !== 'lib/socket.ts') offenders.push(`${rel}: removeAllListeners`);
      }
    };
    walk(CLIENT);
    expect(offenders).toEqual([]);
    expect(read('lib/socket.ts')).toMatch(/export function resetSocket\(\): void \{\s*if \(socket\) \{\s*socket\.removeAllListeners\(\);/);
  });

  it('the live hook takes off exactly the listeners its run added, each by its handler', () => {
    const live = read('hooks/useSessionSocket.ts');
    expect(live).toMatch(/const heldBefore = new Map\(SOCKET_EVENTS\.map\(\(ev\) => \[ev, new Set\(socket\.listeners\(ev\)\)\] as const\)\);/);
    expect(live).toMatch(/socket\.listeners\(ev\)\.filter\(\(fn\) => !heldBefore\.get\(ev\)\?\.has\(fn\)\)/);
    expect(live).toMatch(/for \(const \{ ev, fn \} of ownListeners\) socket\.off\(ev, fn\);/);
    // Its socket.io reconnect listeners come off by handler only.
    expect(live).toMatch(/socket\.io\.off\('reconnect', onReconnect\);/);
    expect(live).not.toMatch(/socket\.io\.off\('reconnect(?:_attempt|_failed)?'\);/);
    // Every registration sits at the effect's top level (or in its one synchronous `if`), so all of them are made
    // between heldBefore and ownListeners: none is registered later, inside a callback, where the clean-up would miss it.
    const body = live.slice(live.indexOf('const heldBefore'), live.indexOf('const ownListeners'));
    const registrations = [...body.matchAll(/^( *)socket\.(?:on|once)\(/gm)].map((m) => m[1].length);
    expect(registrations.length).toBeGreaterThan(40);
    expect(registrations.every((indent) => indent === 4 || indent === 6)).toBe(true);
    expect([...body.matchAll(/^( {6})socket\.(?:on|once)\(/gm)].length).toBe(1);
  });
});
