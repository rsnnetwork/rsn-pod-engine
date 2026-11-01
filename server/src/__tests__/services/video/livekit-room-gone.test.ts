// ─── A LiveKit room that has already closed has nobody in it (26 Oct 2026, H2b item 19) ──────────────────
//
// The reconciliation sweep asks LiveKit who is in each room an event still holds. A room LiveKit has closed answers a
// TwirpError 409 "room has already closed" (sometimes a not-found). On production (2026-10-26T13:40:09Z, right after an
// event ended) that was logged as an ERROR "Failed to list participants" every tick, though a closed room is simply
// empty. `isRoomGone` is the one reader of "this room is no more" for every LiveKit call site; it now reads the 409 and
// the message too, so listParticipants answers an empty list at debug level.

import { isRoomGone } from '../../../services/video/livekit.provider';

describe('isRoomGone: the one reader of "this room is no more"', () => {
  it.each([
    ['Twirp not_found (code 5)', { code: 5, message: 'requested room does not exist' }],
    ['a not_found code', { code: 'not_found', message: 'room not found' }],
    ['an HTTP 404', { status: 404, message: 'no such room' }],
    ['"room has already closed" (409, right after an event ends)', { status: 409, code: 'failed_precondition', message: 'room has already closed' }],
    ['"room has already closed" however it is coded', { code: 9, message: 'twirp error failed_precondition: room has already closed' }],
  ])('reads %s as gone', (_what, err) => {
    expect(isRoomGone(err)).toBe(true);
  });

  it.each([
    ['a timeout', new Error('listParticipants timeout')],
    ['an authentication failure', { status: 401, message: 'invalid API key' }],
    ['a server error', { status: 500, message: 'internal error' }],
    ['a 409 about something else', { status: 409, message: 'participant already exists' }],
    // Review M11: only the room's own closing reads as gone, not anything else that has already closed.
    ['a stream that has already closed', { status: 409, message: 'stream already closed' }],
    ['an egress that has already closed', { code: 9, message: 'egress has already closed' }],
    ['nothing', null],
  ])('does not read %s as gone', (_what, err) => {
    expect(isRoomGone(err)).toBe(false);
  });
});
