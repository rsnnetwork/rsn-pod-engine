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
//
// Fix wave 2 (2 Nov 2026; preview rr9): CX1 read every page-load read twice (a page's reads all start before its
// socket connects): measured on n1-t11, one member's requests went from 242 to 393, past production's 100 a minute, and
// the Requests card and the event page got 429s. The server now remembers for a minute what it sent each member and
// sends a socket that joins those tags at once (server realtime/recent-entities.ts). So the FIRST connect re-reads only
// reads that started more than REPLAY_TRUST_MS (half the server's minute) before it; the replayed entity:changed reads
// again exactly what changed. A reconnect still re-reads every tagged read that started before it (CLAUDE.md section 3:
// after a gap, read everything again). A query that holds data it never fetched (initialData, the session follower)
// counts from when the cache first held it.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { QueryClient } from '@tanstack/query-core';
import { QueryObserver } from '@tanstack/query-core';
import {
  CHANGE_READ_RECENT_MS, CHANGE_READ_WINDOWS, CHANGE_READ_WINDOW_MS, CONNECT_RESYNC_WINDOW_MS, REPLAY_TRUST_MS,
  subscribeEntitySync, type EntitySignals,
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
  it('the window is a few seconds; the server\'s replay is trusted for half its minute', () => {
    expect(CONNECT_RESYNC_WINDOW_MS).toBe(5000);
    expect(REPLAY_TRUST_MS).toBe(30_000);
  });

  it('the FIRST connect leaves reads from the last half minute to the server\'s replay: a page load reads nothing twice', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    const later = Date.now() + 10_000;
    subscribeEntitySync(socket, qc, { now: () => later });
    socket.emit('connect');
    await flush();
    expect(invalidated(qc, ['dm-unread-count'])).toBe(false);
    expect(invalidated(qc, ['pod', 'p1'])).toBe(false);
    qc.clear();
  });

  it('the FIRST connect re-reads a tagged read older than the replay covers', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    const later = Date.now() + REPLAY_TRUST_MS + 5_000;
    subscribeEntitySync(socket, qc, { now: () => later });
    socket.emit('connect');
    await flush();
    expect(invalidated(qc, ['dm-unread-count'])).toBe(true);
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['untagged'])).toBe(false);
    qc.clear();
  });

  it('a query that holds data it never fetched (initialData: the session follower) is not read again on the first connect', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = Date.now();
    subscribeEntitySync(socket, qc, { now: () => t });
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ['auth-session', 'me'], meta: { entities: ['user:me'] }, staleTime: Infinity,
      initialData: { id: 'me' }, initialDataUpdatedAt: Date.now(),
      queryFn: () => { calls += 1; return Promise.resolve({ id: 'me' }); },
    });
    const off = observer.subscribe(() => {});
    t += 2000;
    socket.emit('connect');
    await flush(); await flush();
    expect(calls).toBe(0);
    // A reconnect after a gap reads it again (everything is).
    t += CONNECT_RESYNC_WINDOW_MS + 1000;
    socket.emit('connect');
    await flush(); await flush();
    expect(calls).toBe(1);
    off();
    qc.clear();
  });

  // CX1 + fix wave 2: the exact order of T19's Script E 5b. The page's read starts, the server answers what it holds,
  // the change happens (its entity:changed goes nowhere: the socket is not in its rooms yet), the old answer lands, and
  // the socket connects. The client reads nothing again by itself; the server's replay of the change (the same
  // entity:changed, sent as the socket joins) reads it again, and the page shows the change.
  it('Script E 5b: the replayed tag reads again the read that answered before the change', async () => {
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
    expect(calls).toBe(1);        // not read twice by the client
    socket.emit('entity:changed', { entities: ['meeting:m1'] }); // the server's replay, as the socket joins
    await flush(); await flush();
    expect(calls).toBe(2);
    expect(qc.getQueryData(['meeting', 'm1'])).toBe('new time');
    off();
    qc.clear();
  });

  // Fix round 2 (re-review r1 minor 2): the same order with the replay marked as the server marks it, so the fold into
  // the connect re-read (replayed()) is what reads the landed answer again.
  it('Script E 5b, marked replay: the fold reads again the answer that landed before the change, once', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
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
    await flush();
    server = 'new time';
    deliver('old time');
    await flush();
    t = landing + 1300;
    socket.emit('connect');
    await flush(); await flush();
    expect(calls).toBe(1);
    socket.emit('entity:changed', { entities: ['meeting:m1'], replayed: true });
    await flush(); await flush();
    expect(calls).toBe(2);
    expect(qc.getQueryData(['meeting', 'm1'])).toBe('new time');
    off();
    qc.clear();
  });

  it('a marked replay that arrives while a coalesced connect re-read is waiting is left to that re-read: one read, when the window ends', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const qc = new QueryClient();
      const socket = fakeSocket();
      let t = 6_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      let calls = 0;
      const observer = new QueryObserver(qc, {
        queryKey: ['pod', 'p5'], meta: { entities: ['pod:p5'] },
        queryFn: () => { calls += 1; return Promise.resolve(calls); },
      });
      const off = observer.subscribe(() => {});
      await flush();
      t += 1000;
      socket.emit('connect');     // first connect: the young read is left to the replay
      t += 1000;
      socket.emit('connect');     // a reconnect inside the window: its re-read waits for the window to end
      socket.emit('entity:changed', { entities: ['pod:p5'], replayed: true });
      await flush(); await flush();
      expect(calls).toBe(1);      // the replay did not read it now
      t += CONNECT_RESYNC_WINDOW_MS;
      jest.advanceTimersByTime(CONNECT_RESYNC_WINDOW_MS);
      await flush(); await flush();
      expect(calls).toBe(2);      // the coalesced re-read read it, once
      off();
      qc.clear();
    } finally {
      jest.useRealTimers();
    }
  });

  // Fix round 2 (re-review r1 minor 1): several tags heard during one first read stacked re-reads that cancelled each
  // other (4 requests, 2 thrown away). The re-read after the landing does not cancel one already on its way.
  it('three tags during one first read give exactly one more read once it lands, and the page ends fresh', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    let server = 'v1';
    let calls = 0;
    const pending: Array<() => void> = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['pod', 'p7'], meta: { entities: ['pod:p7'] },
      queryFn: () => { calls += 1; const n = calls; return new Promise<string>((r) => { pending.push(() => r(n === 1 ? 'v1' : server)); }); },
    });
    const off = observer.subscribe(() => {});
    await flush();
    server = 'v2';
    socket.emit('entity:changed', { entities: ['pod:p7'] });
    socket.emit('entity:changed', { entities: ['pod:p7'] });
    socket.emit('entity:changed', { entities: ['pod:p7'] });
    await flush();
    pending[0]();                 // the first read lands
    await flush(); await flush();
    expect(calls).toBe(2);        // one more read, not three cancelling each other
    pending[1]();
    await flush(); await flush();
    expect(calls).toBe(2);
    expect(qc.getQueryData(['pod', 'p7'])).toBe('v2');
    off();
    qc.clear();
  });

  // Fix wave 2, fix round 1 (re-review Important 1): the read can still be ON ITS WAY when the replay arrives. In
  // query-core 5.90, invalidating a query whose first read is in flight returns that read, and its old answer then
  // clears the invalidated flag: the replay changed nothing. A matched first read on its way is read again once it lands.
  it('Script E 5b, first connect: the replay arrives while the old answer is still on its way, and the page still ends fresh', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = Date.now();
    subscribeEntitySync(socket, qc, { now: () => t });
    let server = 'old time';
    let calls = 0;
    const pending: Array<() => void> = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['meeting', 'm1'], meta: { entities: ['meeting:m1'] },
      queryFn: () => { calls += 1; const answer = server; return new Promise<string>((r) => { pending.push(() => r(answer)); }); },
    });
    const off = observer.subscribe(() => {});
    await flush();                // the read reached the server, which answered from the old time
    server = 'new time';          // the move; its entity:changed went to a room this socket was not in yet
    t += 1000;
    socket.emit('connect');       // first connect: the read is young, so the connect itself reads nothing again
    socket.emit('entity:changed', { entities: ['meeting:m1'], replayed: true }); // the server's replay, read still on its way
    await flush();
    expect(calls).toBe(1);
    pending[0]();                 // the old answer lands
    await flush(); await flush();
    expect(calls).toBe(2);        // and is read again at once
    pending[1]();
    await flush(); await flush();
    expect(qc.getQueryData(['meeting', 'm1'])).toBe('new time');
    off();
    qc.clear();
  });

  it('a live tag that arrives while a first read is on its way reads it again once it lands', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    let server = 'before';
    let calls = 0;
    const pending: Array<() => void> = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['pod', 'p9'], meta: { entities: ['pod:p9'] },
      queryFn: () => { calls += 1; const answer = server; return new Promise<string>((r) => { pending.push(() => r(answer)); }); },
    });
    const off = observer.subscribe(() => {});
    await flush();
    server = 'after';
    socket.emit('entity:changed', { entities: ['pod:p9'] });
    await flush();
    pending[0]();
    await flush(); await flush();
    expect(calls).toBe(2);
    pending[1]();
    await flush(); await flush();
    expect(qc.getQueryData(['pod', 'p9'])).toBe('after');
    off();
    qc.clear();
  });

  // Fix round 1 (re-review Minor 1): on a reconnect the connect re-read has just sent every tagged read; the replay that
  // follows names some of them again. It is folded into that re-read: nothing is cancelled or sent twice.
  it('a reconnect sends each read once: the replay right after the connect re-read adds nothing', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = 4_000_000;
    subscribeEntitySync(socket, qc, { now: () => t });
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ['pod', 'p2'], meta: { entities: ['pod:p2'] },
      // The page's first read answers; every read after it stays on its way, so a second send would show.
      queryFn: () => { calls += 1; return calls === 1 ? Promise.resolve(1) : new Promise<number>(() => {}); },
    });
    const off = observer.subscribe(() => {});
    await flush();
    socket.emit('connect');
    t += CONNECT_RESYNC_WINDOW_MS + 1000;
    socket.emit('connect');       // a reconnect (a token refresh, a phone back online): every tagged read is sent again
    await flush();
    const afterResync = calls;
    socket.emit('entity:changed', { entities: ['pod:p2'], replayed: true });
    await flush(); await flush();
    expect(calls).toBe(afterResync);
    off();
    qc.clear();
  });

  it('a replay heard with no connect seen (the socket was up before this subscription) is read as any change', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    socket.emit('entity:changed', { entities: ['pod:p1'], replayed: true });
    await flush();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    qc.clear();
  });

  // A RECONNECT re-reads every tagged read that started before it. A first read (no data yet) still on its way is read
  // again the moment it lands: cancelling it would fail whoever awaits it.
  it('after a reconnect, a read still on its way from before it is read again, so the page ends on an answer from after it', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = 2_000_000;
    subscribeEntitySync(socket, qc, { now: () => t });
    socket.emit('connect');       // the page's socket connected; then it dropped
    t += CONNECT_RESYNC_WINDOW_MS + 1000;
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

  it('after a reconnect, a refresh with data still on its way from before it is sent again at once', async () => {
    const qc = new QueryClient();
    const socket = fakeSocket();
    let t = 2_500_000;
    subscribeEntitySync(socket, qc, { now: () => t });
    socket.emit('connect');
    t += CONNECT_RESYNC_WINDOW_MS + 1000;
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

  it('a lone entity:changed refreshes exactly the reads that declare one of its tags, at once', async () => {
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

  // Final preview fix (11 Nov 2026): eight people registering within two seconds sent each of an organiser's eleven
  // session reads eight times (each change cancelled and resent the last), the organiser's 240 requests a minute ran out,
  // and Cancel event's read was refused (429): the page kept "Registration open" over a cancelled event.
  describe('a burst of changes reads each query at once, then at most once per window, never once per change', () => {
    /** The queries an invalidateQueries call reached, by key (its predicate run over the cache). */
    const reached = (qc: QueryClient, call: unknown[]) => {
      const filters = call[0] as { predicate?: (q: unknown) => boolean };
      return qc.getQueryCache().getAll().filter((q) => filters.predicate?.(q)).map((q) => JSON.stringify(q.queryKey));
    };
    const readsOf = (qc: QueryClient, spy: jest.SpyInstance, key: unknown[]) =>
      spy.mock.calls.filter((call) => reached(qc, call).includes(JSON.stringify(key))).length;

    it('the window is a second', () => {
      expect(CHANGE_READ_WINDOW_MS).toBe(1000);
    });

    it('eight changes 250 ms apart read the event three times (at once, then at the end of each window), not eight', async () => {
      const qc = new QueryClient();
      await qc.fetchQuery({ queryKey: ['session', 's1'], queryFn: () => ({}), meta: { entities: ['session:s1'] } });
      await qc.fetchQuery({ queryKey: ['pod', 'p1'], queryFn: () => ({}), meta: { entities: ['pod:p1'] } });
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const spy = jest.spyOn(qc, 'invalidateQueries');
        const socket = fakeSocket();
        let t = 2_000_000;
        subscribeEntitySync(socket, qc, { now: () => t });
        socket.emit('entity:changed', { entities: ['session:s1'] });
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(1);           // the first change: at once
        expect(invalidated(qc, ['session', 's1'])).toBe(true);
        for (let i = 1; i < 8; i++) {
          t += 250; jest.advanceTimersByTime(250);
          socket.emit('entity:changed', { entities: ['session:s1'] });
        }
        t += 250; jest.advanceTimersByTime(250);
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(3);
        // The last change (at 1750 ms) is answered by the read at 2000 ms: nothing after it is left unread.
        t += 10_000; jest.advanceTimersByTime(10_000);
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(3);
        expect(readsOf(qc, spy, ['pod', 'p1'])).toBe(0);              // a read no change named is never touched
        // A change after a quiet window is read at once again.
        socket.emit('entity:changed', { entities: ['session:s1'] });
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(4);
      } finally {
        jest.useRealTimers();
        qc.clear();
      }
    });

    it('one query\'s window never holds back another: a change naming only the event is read at once', async () => {
      const qc = new QueryClient();
      await qc.fetchQuery({ queryKey: ['session', 's1'], queryFn: () => ({}), meta: { entities: ['session:s1'] } });
      await qc.fetchQuery({ queryKey: ['pod', 'p1'], queryFn: () => ({}), meta: { entities: ['pod:p1', 'session:s1'] } });
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const spy = jest.spyOn(qc, 'invalidateQueries');
        const socket = fakeSocket();
        let t = 3_000_000;
        subscribeEntitySync(socket, qc, { now: () => t });
        socket.emit('entity:changed', { entities: ['pod:p1'] });
        t += 100; jest.advanceTimersByTime(100);
        socket.emit('entity:changed', { entities: ['session:s1'] });
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(1);          // at once: its own window had not started
        expect(readsOf(qc, spy, ['pod', 'p1'])).toBe(1);              // read 100 ms ago: waits for its window's end
        t += 900; jest.advanceTimersByTime(900);
        expect(readsOf(qc, spy, ['pod', 'p1'])).toBe(2);
      } finally {
        jest.useRealTimers();
        qc.clear();
      }
    });

    it('the page ends on the latest answer: the read at the window\'s end carries the last change', async () => {
      const qc = new QueryClient();
      let server = 'Registration open';
      let calls = 0;
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const socket = fakeSocket();
        let t = 4_000_000;
        subscribeEntitySync(socket, qc, { now: () => t });
        const observer = new QueryObserver(qc, {
          queryKey: ['session', 's2'], meta: { entities: ['session:s2'] },
          queryFn: () => { calls += 1; return Promise.resolve(server); },
        });
        const off = observer.subscribe(() => {});
        await flush(); await flush();
        expect(calls).toBe(1);
        socket.emit('entity:changed', { entities: ['session:s2'] });   // someone registered
        await flush(); await flush();
        expect(calls).toBe(2);
        server = 'Cancelled';
        t += 300; jest.advanceTimersByTime(300);
        socket.emit('entity:changed', { entities: ['session:s2'] });   // the organiser cancelled, 300 ms later
        await flush(); await flush();
        expect(calls).toBe(2);
        t += 700; jest.advanceTimersByTime(700);
        await flush(); await flush();
        expect(calls).toBe(3);
        expect(qc.getQueryData(['session', 's2'])).toBe('Cancelled');
        off();
      } finally {
        jest.useRealTimers();
        qc.clear();
      }
    });

    it('unsubscribing drops a read waiting for its window\'s end', async () => {
      const qc = new QueryClient();
      await qc.fetchQuery({ queryKey: ['session', 's1'], queryFn: () => ({}), meta: { entities: ['session:s1'] } });
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const spy = jest.spyOn(qc, 'invalidateQueries');
        const socket = fakeSocket();
        let t = 5_000_000;
        const off = subscribeEntitySync(socket, qc, { now: () => t });
        socket.emit('entity:changed', { entities: ['session:s1'] });
        t += 200; jest.advanceTimersByTime(200);
        socket.emit('entity:changed', { entities: ['session:s1'] });
        off();
        t += 5_000; jest.advanceTimersByTime(5_000);
        expect(readsOf(qc, spy, ['session', 's1'])).toBe(1);
      } finally {
        jest.useRealTimers();
        qc.clear();
      }
    });
  });

  // Review of the final preview fix (11 Nov 2026): I3 (a steady stream, not only a burst, stays under the limit), I4 (a
  // read on its way is never cancelled for a change), M1 (a waiting re-read ends with the subscription), M4 (a first read
  // on its way inside a burst).
  describe('a steady stream, slow reads and reads on their way', () => {
    const reached = (qc: QueryClient, call: unknown[]) => {
      const filters = call[0] as { predicate?: (q: unknown) => boolean };
      return qc.getQueryCache().getAll().filter((q) => filters.predicate?.(q)).map((q) => JSON.stringify(q.queryKey));
    };
    const readsOf = (qc: QueryClient, spy: jest.SpyInstance, key: unknown[]) =>
      spy.mock.calls.filter((call) => reached(qc, call).includes(JSON.stringify(key))).length;

    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));
    afterEach(() => jest.useRealTimers());

    it('the window grows to 3 s after 6 change reads in a minute and to 5 s after 12', () => {
      expect(CHANGE_READ_RECENT_MS).toBe(60_000);
      expect(CHANGE_READ_WINDOWS).toEqual([{ after: 12, ms: 5000 }, { after: 6, ms: 3000 }]);
    });

    it('a change every 2.5 s for three minutes: about one read in 3 to 5 s once it is busy, each change still answered', async () => {
      const qc = new QueryClient();
      await qc.fetchQuery({ queryKey: ['session', 's1'], queryFn: () => ({}), meta: { entities: ['session:s1'] } });
      const spy = jest.spyOn(qc, 'invalidateQueries');
      const socket = fakeSocket();
      let t = 7_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      const readsAt: number[] = [];
      let seen = 0;
      const tick = (ms: number) => {
        for (let i = 0; i < ms; i += 100) {
          t += 100; jest.advanceTimersByTime(100);
          const n = readsOf(qc, spy, ['session', 's1']);
          for (; seen < n; seen++) readsAt.push(t);
        }
      };
      const changes: number[] = [];
      for (let i = 0; i < 72; i++) { // 180 s
        changes.push(t);
        socket.emit('entity:changed', { entities: ['session:s1'] });
        const n = readsOf(qc, spy, ['session', 's1']);
        for (; seen < n; seen++) readsAt.push(t);
        tick(2500);
      }
      tick(6000);
      const inMinute = (from: number) => readsAt.filter((at) => at >= changes[0] + from && at < changes[0] + from + 60_000).length;
      // Once per change would be 24 a minute; busy, the 3 s and 5 s windows hold it near twelve.
      expect(inMinute(0)).toBeLessThanOrEqual(18);
      expect(inMinute(60_000)).toBeLessThanOrEqual(13);
      expect(inMinute(120_000)).toBeLessThanOrEqual(13);
      // No change is left unread, and none waits longer than the widest window.
      for (const at of changes) {
        const answered = readsAt.find((r) => r >= at);
        expect(answered).toBeDefined();
        expect(answered! - at).toBeLessThanOrEqual(5000);
      }
      // Quiet for a minute, the window is back to a second: a change at once, the next one a second later.
      tick(70_000);
      const before = readsOf(qc, spy, ['session', 's1']);
      socket.emit('entity:changed', { entities: ['session:s1'] });
      expect(readsOf(qc, spy, ['session', 's1'])).toBe(before + 1);
      tick(200);
      socket.emit('entity:changed', { entities: ['session:s1'] });
      tick(700);
      expect(readsOf(qc, spy, ['session', 's1'])).toBe(before + 1);
      tick(200);
      expect(readsOf(qc, spy, ['session', 's1'])).toBe(before + 2);
      qc.clear();
    });

    it('reads slower than the window (1.5 s), a change every 400 ms: nothing is cancelled, answers land during the burst, the last one is current', async () => {
      const qc = new QueryClient();
      const socket = fakeSocket();
      let t = 8_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      let server = 0;
      let sent = 0;
      let aborted = 0;
      const landed: number[] = [];
      const observer = new QueryObserver(qc, {
        queryKey: ['session', 's3'], meta: { entities: ['session:s3'] }, retry: false,
        queryFn: ({ signal }) => {
          sent += 1;
          const answer = server;
          signal.addEventListener('abort', () => { aborted += 1; });
          return new Promise<number>((resolve) => setTimeout(() => { landed.push(answer); resolve(answer); }, 1500));
        },
      });
      const off = observer.subscribe(() => {});
      const step = async (ms: number) => {
        for (let i = 0; i < ms; i += 100) { t += 100; jest.advanceTimersByTime(100); await flush(); await flush(); }
      };
      await step(1600);                         // the page's first read lands
      expect(landed).toEqual([0]);
      for (let i = 0; i < 15; i++) {            // 6 s of changes
        server += 1;
        socket.emit('entity:changed', { entities: ['session:s3'] });
        await step(400);
      }
      expect(aborted).toBe(0);
      expect(landed.length).toBeGreaterThanOrEqual(4); // answers kept landing during the burst
      await step(5000);
      expect(aborted).toBe(0);
      expect(qc.getQueryData(['session', 's3'])).toBe(server);
      expect(sent).toBe(landed.length);
      off(); qc.clear();
    });

    it('a burst during a first read on its way: one more read the moment it lands, then the page is current', async () => {
      const qc = new QueryClient();
      const socket = fakeSocket();
      let t = 9_000_000;
      subscribeEntitySync(socket, qc, { now: () => t });
      let server = 'v0';
      let calls = 0;
      const observer = new QueryObserver(qc, {
        queryKey: ['pod', 'p4'], meta: { entities: ['pod:p4'] }, retry: false,
        queryFn: () => { calls += 1; const answer = server; return new Promise<string>((r) => setTimeout(() => r(answer), 1000)); },
      });
      const off = observer.subscribe(() => {});
      const step = async (ms: number) => {
        for (let i = 0; i < ms; i += 100) { t += 100; jest.advanceTimersByTime(100); await flush(); await flush(); }
      };
      for (let i = 1; i <= 3; i++) { server = `v${i}`; socket.emit('entity:changed', { entities: ['pod:p4'] }); await step(200); }
      expect(calls).toBe(1);                    // all three joined the read due once the first lands
      await step(500);                           // it lands at 1000 ms, and is read once more at once
      expect(calls).toBe(2);
      await step(1100);
      expect(qc.getQueryData(['pod', 'p4'])).toBe('v3');
      expect(calls).toBe(2);
      off(); qc.clear();
    });

    it('unsubscribing while a re-read waits for a read on its way sends nothing when it lands', async () => {
      const qc = new QueryClient();
      const spy = jest.spyOn(qc, 'invalidateQueries');
      const socket = fakeSocket();
      let t = 10_000_000;
      const unsubscribe = subscribeEntitySync(socket, qc, { now: () => t });
      let calls = 0;
      const observer = new QueryObserver(qc, {
        queryKey: ['pod', 'p5'], meta: { entities: ['pod:p5'] }, retry: false,
        queryFn: () => { calls += 1; return new Promise<string>((r) => setTimeout(() => r('x'), 1000)); },
      });
      const off = observer.subscribe(() => {});
      socket.emit('entity:changed', { entities: ['pod:p5'] });
      unsubscribe();
      t += 2000; jest.advanceTimersByTime(2000); await flush(); await flush();
      expect(spy).not.toHaveBeenCalled();
      expect(calls).toBe(1);
      off(); qc.clear();
    });
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
