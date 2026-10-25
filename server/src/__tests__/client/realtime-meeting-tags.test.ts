// ─── The client builds the meeting tags as the server sends them (26 Oct 2026) ─
//
// A query only refreshes when the tag it declares is, letter for letter, the tag the server sends.
// The server tells both people user:<id>:meetings and meeting:<id> whenever a meeting is booked,
// moved, cancelled, attended or reminded (services/meetings/meeting-tags.ts). The Events list, the
// Events count and the meeting's page will declare them through the client's own `E`, so the two
// builders are compared here. (On the preview branch, realtime-entity-tags.test.ts also compares every
// builder on both sides.)

import { E as clientE } from '../../../../client/src/realtime/entities';
import { E as serverE } from '../../realtime/entities';

describe('the meeting tags', () => {
  it('a member\'s meetings: user:<id>:meetings, the same on both sides', () => {
    expect(clientE.userMeetings('u-1')).toBe('user:u-1:meetings');
    expect(clientE.userMeetings('u-1')).toBe(serverE.userMeetings('u-1'));
  });

  it('one meeting: meeting:<id>, the same on both sides', () => {
    expect(clientE.meeting('m-1')).toBe('meeting:m-1');
    expect(clientE.meeting('m-1')).toBe(serverE.meeting('m-1'));
  });
});
