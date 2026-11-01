// ─── Every tagged read is refreshed when the socket connects, the first time and after a gap (P1 item 17 + X1) ──────
//
// A socket that was down heard none of the entity:changed sent meanwhile, and neither did a freshly opened tab between
// its first reads and its socket's first connect (seen on the preview: a message landing in that window left the new
// tab's count at 1). So on every connect, the first included, each read that declares meta.entities is refreshed once,
// through the same rule entity:changed uses. The screens' own "refetch on connect" listeners are then redundant and go.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { QueryClient } from '@tanstack/query-core';
import {
  invalidateEveryTaggedRead, subscribeEntitySync, type EntitySignals,
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

describe('invalidateEveryTaggedRead', () => {
  it('refreshes every read that declares at least one tag, and nothing else', async () => {
    const qc = await cacheWith();
    await invalidateEveryTaggedRead(qc);
    expect(invalidated(qc, ['dm-unread-count'])).toBe(true);
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['empty-tags'])).toBe(false);
    expect(invalidated(qc, ['untagged'])).toBe(false);
    qc.clear();
  });
});

describe('subscribeEntitySync: one listener set for the whole app', () => {
  it('the socket\'s FIRST connect refreshes every tagged read (a new tab missed what came before it)', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    socket.emit('connect');
    await Promise.resolve();
    expect(invalidated(qc, ['dm-unread-count'])).toBe(true);
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['untagged'])).toBe(false);
    qc.clear();
  });

  it('a reconnect after a gap refreshes them again', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    socket.emit('connect');
    await qc.refetchQueries();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(false);
    socket.emit('connect');
    await Promise.resolve();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    qc.clear();
  });

  it('entity:changed refreshes exactly the reads that declare one of its tags', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    subscribeEntitySync(socket, qc);
    socket.emit('entity:changed', { entities: ['pod:p1'] });
    await Promise.resolve();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(true);
    expect(invalidated(qc, ['dm-unread-count'])).toBe(false);
    socket.emit('entity:changed', {});
    qc.clear();
  });

  it('unsubscribing takes both listeners off', async () => {
    const qc = await cacheWith();
    const socket = fakeSocket();
    const off = subscribeEntitySync(socket, qc);
    off();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('entity:changed')).toBe(0);
    socket.emit('connect');
    await Promise.resolve();
    expect(invalidated(qc, ['pod', 'p1'])).toBe(false);
    qc.clear();
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
