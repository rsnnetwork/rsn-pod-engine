// ─── The client builds the group chat tag as the server sends it (26 Oct 2026) ─
//
// A query only refreshes when the tag it declares is, letter for letter, the tag the server sends. Every
// change to a group chat sends each member dm-group:<id> with their own user:<id>:dms
// (realtime/fanout.ts, fanoutGroupEntities). The group thread and its members sheet will declare the group
// tag through the client's own `E`, so the two builders are compared here. (On the preview branch,
// realtime-entity-tags.test.ts also compares every builder on both sides.)

import { E as clientE } from '../../../../client/src/realtime/entities';
import { E as serverE } from '../../realtime/entities';

describe('the group chat tag', () => {
  it('one group: dm-group:<id>, the same on both sides', () => {
    expect(clientE.dmGroup('g-1')).toBe('dm-group:g-1');
    expect(clientE.dmGroup('g-1')).toBe(serverE.dmGroup('g-1'));
  });

  it('a member\'s Messages, sent with it: user:<id>:dms, the same on both sides', () => {
    expect(clientE.userDms('u-1')).toBe('user:u-1:dms');
    expect(clientE.userDms('u-1')).toBe(serverE.userDms('u-1'));
  });
});
