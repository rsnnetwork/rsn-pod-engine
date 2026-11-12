// ─── A pod page whose read of the pod landed just before a change settles on the new status (12 Nov 2026) ───────────
//
// pod-wall.spec.ts "a page that read the pod a moment before the archive was saved still ends up saying archived": the
// first read of the pod after the archive answered the old status ("active"). The wall's feed already knew (the
// composer went), but the note under the wall said "This pod is not open for new activity right now." for 20 s,
// because nothing read the pod again.
//
// Now the pod wall's feed says the status it found (PodWallFeed.podStatus), the wall passes it to the pod page, and
// when the two disagree the pod is read again by its entity tag, at most once per disagreement. Run here with a real
// query client: the stale read is read again once, a re-read that is still stale does not ask again, and a later
// disagreement asks again.

import * as fs from 'fs';
import * as path from 'path';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { invalidateEntities } from '../../../../client/src/realtime/invalidate-entities';
import { E } from '../../../../client/src/realtime/entities';
import {
  createPodStatusRecheck, podCannotPostNote, podStatusDisagreement, podWallConfig,
} from '../../../../client/src/features/pods/pod-wall-config';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const POD = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
const OTHER_POD = '9a9a9a9a-2222-4222-8222-222222222222';

describe('when the feed and the page disagree about the pod', () => {
  it('names the disagreement only when both have answered and they differ', () => {
    expect(podStatusDisagreement('archived', 'active')).toBe('archived|active');
    expect(podStatusDisagreement('active', 'archived')).toBe('active|archived');
    expect(podStatusDisagreement('archived', 'archived')).toBeNull();
    expect(podStatusDisagreement(undefined, 'active')).toBeNull();
    expect(podStatusDisagreement('archived', undefined)).toBeNull();
  });

  it('reads again once per disagreement: never twice for the same one, again for a new one after they agreed', () => {
    const reread = jest.fn();
    const check = createPodStatusRecheck(reread);

    check(undefined, 'active');
    check('active', 'active');
    expect(reread).not.toHaveBeenCalled();

    check('archived', 'active');
    expect(reread).toHaveBeenCalledTimes(1);
    // The re-read answered the same stale status again (or the feed re-read too and both answers stand): no loop.
    check('archived', 'active');
    check('archived', 'active');
    expect(reread).toHaveBeenCalledTimes(1);

    check('archived', 'archived');
    expect(reread).toHaveBeenCalledTimes(1);

    // Reactivated: the feed hears it first this time. A new disagreement, so one more read.
    check('active', 'archived');
    expect(reread).toHaveBeenCalledTimes(2);
    check('active', 'archived');
    expect(reread).toHaveBeenCalledTimes(2);
  });
});

describe('with a real query client: the pod page\'s read is read again, once', () => {
  function podPage(client: QueryClient, podId: string, answers: string[]) {
    const queryFn = jest.fn(async () => ({ id: podId, status: answers.shift() ?? 'archived' }));
    const observer = new QueryObserver(client, { queryKey: ['pod', podId], queryFn, meta: { entities: [E.pod(podId)] }, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    return { observer, queryFn, unsubscribe };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a stale read of the pod is read again and the note under the wall then says archived', async () => {
    const client = new QueryClient();
    // The first read answers "active" (it landed a moment before the archive was saved); the next answers the truth.
    const page = podPage(client, POD, ['active', 'archived']);
    const other = podPage(client, OTHER_POD, ['active']);
    await settle();
    expect(page.observer.getCurrentResult().data?.status).toBe('active');

    const check = createPodStatusRecheck(() => { void invalidateEntities(client, [E.pod(POD)]); });
    check('archived', page.observer.getCurrentResult().data?.status);
    await settle();
    await settle();

    expect(page.queryFn).toHaveBeenCalledTimes(2);
    const status = page.observer.getCurrentResult().data?.status;
    expect(status).toBe('archived');
    expect(podCannotPostNote(status, true)).toBe('This pod is archived, so its discussion is read-only.');
    // Only that pod's reads: another pod's page is left alone.
    expect(other.queryFn).toHaveBeenCalledTimes(1);

    check('archived', status);
    await settle();
    expect(page.queryFn).toHaveBeenCalledTimes(2);
    page.unsubscribe();
    other.unsubscribe();
  });

  it('a re-read that is still stale is not followed by another', async () => {
    const client = new QueryClient();
    const page = podPage(client, POD, ['active', 'active', 'active']);
    await settle();
    const check = createPodStatusRecheck(() => { void invalidateEntities(client, [E.pod(POD)]); });

    check('archived', page.observer.getCurrentResult().data?.status);
    await settle();
    await settle();
    check('archived', page.observer.getCurrentResult().data?.status);
    await settle();

    expect(page.queryFn).toHaveBeenCalledTimes(2);
    page.unsubscribe();
  });

  it('the tag it reads again by is the one the pod page\'s query declares, and the wall\'s feed declares it too', () => {
    const page = read('features/pods/PodDetailPage.tsx');
    expect(page).toMatch(/queryKey: \['pod', podId\][\s\S]{0,400}meta: \{ entities: podId \? \[E\.pod\(podId\)\] : \[\] \}/);
    expect(podWallConfig({ podId: POD, me: undefined, podStatus: 'active', isActiveMember: true }).entities.feed).toContain(E.pod(POD));
    expect(read('features/pods/usePodStatusRecheck.ts')).toMatch(/invalidateEntities\(queryClient, \[E\.pod\(podId\)\]\)/);
    expect(read('features/pods/usePodStatusRecheck.ts')).not.toMatch(/setQueryData|setInterval|setTimeout/);
  });
});

describe('the wiring', () => {
  it('the wall passes on the status its feed\'s first page found, and only when there is one', () => {
    const wall = read('components/wall/Wall.tsx');
    expect(wall).toMatch(/const feedPodStatus = feed\.data\?\.pages\[0\]\?\.podStatus;/);
    expect(wall).toMatch(/if \(feedPodStatus\) onFeedPodStatus\?\.\(feedPodStatus\);/);
  });

  it('the pod wall compares it with the status the page read, through the bounded check', () => {
    const podWall = read('features/pods/PodWall.tsx');
    expect(podWall).toMatch(/usePodStatusRecheck\(podId, feedPodStatus, podStatus\)/);
    expect(podWall).toMatch(/onFeedPodStatus=\{setFeedPodStatus\}/);
    expect(read('features/pods/usePodStatusRecheck.ts')).toMatch(/createPodStatusRecheck\(/);
  });

  it('the feed\'s type says it', () => {
    expect(read('components/wall/wall-types.ts')).toMatch(/podStatus\?: string;/);
    const shared = fs.readFileSync(path.join(__dirname, '../../../../shared/src/types/wall.ts'), 'utf8');
    expect(shared).toMatch(/export interface PodWallFeed \{[\s\S]*?podStatus: string;/);
  });
});
