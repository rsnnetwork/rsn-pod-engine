// ─── An in-person event has no video room (30 Oct 2026, T12, D10) ───────────────────────────────
//
// An event whose format's live kind is 'none' (In person) happens at a place: nothing opens a LiveKit room for it,
// and nothing mints a token into one. Production's client, opened from an invite email, still shows Enter Event;
// the server answers it with this sentence instead of a room.

import { ErrorCodes, EventFormat, liveKindOf } from '@rsn/shared';
import { ConflictError } from '../../middleware/errors';

export const NO_VIDEO_ROOM = {
  code: ErrorCodes.NOT_A_VIDEO_EVENT,
  message: 'This event happens in person, so there is no video room.',
} as const;

export function hasVideoRoom(format: EventFormat): boolean {
  return liveKindOf(format) !== 'none';
}

/** 409 NOT_A_VIDEO_EVENT for an event with no video room (REST Go Live, a LiveKit token). */
export function assertVideoRoom(format: EventFormat): void {
  if (!hasVideoRoom(format)) throw new ConflictError(NO_VIDEO_ROOM.code, NO_VIDEO_ROOM.message);
}
