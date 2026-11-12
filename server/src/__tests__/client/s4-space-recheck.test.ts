// ─── A wall write refused because the space closed reads the space again (12 Nov 2026, prod smoke) ───────────────
//
// pod-wall.spec.ts "a page that never heard the pod was archived...": the server refused the post with "This pod is
// archived, so its discussion is read-only" and the composer went, but the note under the wall said "This pod is not
// open for new activity right now." The note comes from the pod's status on screen (podCannotPostNote), and nothing read
// the pod again after the refusal, because the archive was never heard over the socket.
//
// Now a refusal whose code says the space itself closed (POD_ARCHIVED, POD_NOT_ACTIVE, CIRCLE_ARCHIVED) invalidates the
// space's own reads by their entity tags, through the same rule the app-wide entity:changed handler uses
// (invalidateEntities). Run here with a real query client: the pod's read is read again and the note says archived.

import * as fs from 'fs';
import * as path from 'path';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { invalidateEntities } from '../../../../client/src/realtime/invalidate-entities';
import { SPACE_CLOSED_CODES, isConflict, isSpaceClosed } from '../../../../client/src/components/wall/wall-logic';
import { podCannotPostNote, podWallConfig } from '../../../../client/src/features/pods/pod-wall-config';
import { circleWallConfig } from '../../../../client/src/features/circles/circle-wall-config';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const POD = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
const CIRCLE = 'c1c1c1c1-1111-4111-8111-111111111111';
const ME = 'c0ffee00-0000-4000-8000-000000000001';
const refusal = (status: number, code: string) => ({ response: { status, data: { error: { code, message: 'x' } } } });

describe('which refusals say the space itself closed', () => {
  it.each(SPACE_CLOSED_CODES)('a 409 %s does', (code) => {
    expect(isSpaceClosed(refusal(409, code))).toBe(true);
  });

  it('a 409 about the item does not (a fourth pin, an edit over another, a post already sent), nor any other answer', () => {
    for (const code of ['WALL_PINS_FULL', 'WALL_EDIT_CONFLICT', 'VALIDATION_ERROR']) {
      expect(isConflict(refusal(409, code))).toBe(true);
      expect(isSpaceClosed(refusal(409, code))).toBe(false);
    }
    expect(isSpaceClosed(refusal(403, 'POD_ARCHIVED'))).toBe(false);
    expect(isSpaceClosed(new Error('Network Error'))).toBe(false);
    expect(isSpaceClosed(undefined)).toBe(false);
  });
});

describe('each wall names its space\'s own reads', () => {
  it('the pod wall: the pod and its members (its page reads its status and the viewer\'s place there)', () => {
    expect(podWallConfig({ podId: POD, me: ME, podStatus: 'active', isActiveMember: true }).spaceEntities).toEqual([`pod:${POD}`, `pod:${POD}:members`]);
  });

  it('the circle wall: the circle and its members', () => {
    expect(circleWallConfig({ circleId: CIRCLE, me: ME, isMember: true }).spaceEntities).toEqual([`circle:${CIRCLE}`, `circle:${CIRCLE}:members`]);
  });
});

describe('a refused post on a page that never heard the archive', () => {
  it('reads the pod again, and the note under the wall says archived', async () => {
    const server = { status: 'active' };
    let reads = 0;
    const qc = new QueryClient();
    // The pod's page read, as PodDetailPage declares it.
    const pod = new QueryObserver(qc, {
      queryKey: ['pod', POD],
      queryFn: async () => { reads += 1; return { status: server.status }; },
      meta: { entities: [`pod:${POD}`] },
    });
    const off = pod.subscribe(() => undefined);
    await pod.refetch();
    const firstReads = reads;
    const note = () => podCannotPostNote((pod.getCurrentResult().data as { status: string }).status, true);
    expect(note()).toBe('This pod is not open for new activity right now.');

    // The pod is archived straight in the database: no entity:changed arrives. The member posts and is refused.
    server.status = 'archived';
    const err = refusal(409, 'POD_ARCHIVED');
    const config = podWallConfig({ podId: POD, me: ME, podStatus: 'active', isActiveMember: true });
    // What useSpaceRecheck does with the refusal.
    if (isSpaceClosed(err)) await invalidateEntities(qc, config.spaceEntities);

    expect(reads).toBe(firstReads + 1);
    expect(note()).toBe('This pod is archived, so its discussion is read-only.');
    off();
    qc.clear();
  });

  it('a refusal about the item reads nothing again', async () => {
    let reads = 0;
    const qc = new QueryClient();
    const pod = new QueryObserver(qc, {
      queryKey: ['pod', POD], queryFn: async () => { reads += 1; return { status: 'active' }; }, meta: { entities: [`pod:${POD}`] },
    });
    const off = pod.subscribe(() => undefined);
    await pod.refetch();
    const before = reads;
    const err = refusal(409, 'WALL_PINS_FULL');
    if (isSpaceClosed(err)) await invalidateEntities(qc, podWallConfig({ podId: POD, me: ME, podStatus: 'active', isActiveMember: true }).spaceEntities);
    expect(reads).toBe(before);
    off();
    qc.clear();
  });
});

describe('every wall write that can be refused this way rechecks the space', () => {
  const hook = read('components/wall/useSpaceRecheck.ts');

  it('the hook goes through invalidateEntities with the wall\'s space tags, and writes nothing into the cache by hand', () => {
    expect(hook).toMatch(/if \(isSpaceClosed\(err\)\) void invalidateEntities\(queryClient, tags\);/);
    expect(hook).toMatch(/const tags = config\.spaceEntities;/);
    expect(hook).not.toMatch(/setQueryData|setQueriesData/);
  });

  it.each([
    ['components/wall/WallComposer.tsx', 1],
    ['components/wall/WallPostReactions.tsx', 1],
    ['components/wall/WallComments.tsx', 2],
  ])('%s: each refused write (a post, a reaction, a comment or reply, a like) calls it after the wall refresh', (file, n) => {
    const src = read(file);
    expect(src).toMatch(/const recheckSpace = useSpaceRecheck\(config\);/);
    expect((src.match(/if \(isConflict\(err\)\) on(?:Settled|Changed)\(\);\n\s+(?:\/\/[^\n]*\n\s+)?recheckSpace\(err\);/g) ?? []).length).toBe(n);
  });

  it('an edit refused as archived rechecks the space too, and still shows its refusal under the box', () => {
    for (const file of ['components/wall/WallPostCard.tsx', 'components/wall/WallComments.tsx']) {
      expect(read(file)).toMatch(/\.catch\(\(err: unknown\) => \{ recheckSpace\(err\); throw err; \}\)/);
    }
  });
});
