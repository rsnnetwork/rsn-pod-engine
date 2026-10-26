// ─── The client builds the pod wall's tags as the server sends them (26 Oct 2026) ─
//
// A query only refreshes when the tag it declares is, letter for letter, the tag the server sends.
// The server tells a pod's ACTIVE members pod:<id>:wall whenever a post is made, deleted or pinned or a
// comment or reaction moves a count, and pod-wall-post:<id> whenever one post's thread changes
// (realtime/fanout.ts, fanoutPodWall). The pod wall's feed and a post's thread will declare them through
// the client's own `E`, so the two builders are compared here. (On the preview branch,
// realtime-entity-tags.test.ts also compares every builder on both sides.)

import { E as clientE } from '../../../../client/src/realtime/entities';
import { E as serverE } from '../../realtime/entities';

describe('the pod wall tags', () => {
  it('a pod\'s wall: pod:<id>:wall, the same on both sides', () => {
    expect(clientE.podWall('p-1')).toBe('pod:p-1:wall');
    expect(clientE.podWall('p-1')).toBe(serverE.podWall('p-1'));
  });

  it('one post\'s thread: pod-wall-post:<id>, the same on both sides', () => {
    expect(clientE.podWallPost('x-1')).toBe('pod-wall-post:x-1');
    expect(clientE.podWallPost('x-1')).toBe(serverE.podWallPost('x-1'));
  });

  it('neither tag collides with the pod\'s own tags, which a wall change must not re-send', () => {
    const tags = [clientE.pod('p-1'), clientE.podMembers('p-1'), clientE.podInvites('p-1'), clientE.podSessions('p-1')];
    expect(tags).not.toContain(clientE.podWall('p-1'));
    expect(tags).not.toContain(clientE.podWallPost('p-1'));
  });
});
