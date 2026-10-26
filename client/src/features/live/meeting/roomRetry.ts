// ─── When the meeting's video room is connected again (fix round 1, 26 Oct 2026) ───
//
// <LiveKitRoom> hands its onError both the failures to connect and the failures to
// publish a camera or a microphone. Only a connection failure is mended by
// connecting again. Retrying a microphone that is denied, missing or held by
// another app (NotReadableError, common on Windows) reconnected the room every few
// seconds for the whole meeting: that person's tile flickered for everyone and each
// cycle asked for a new token. Pure, no LiveKit import: the server's jest reads it.

/** Connection retries before the room waits for the person to come back to it (ReconnectOnReturn). */
export const ROOM_RETRY_LIMIT = 2;
/** The pause before a retry, in ms. */
export const ROOM_RETRY_DELAY_MS = 2_000;
/** How long a connection has to hold before its retries are counted afresh, in ms. */
export const ROOM_STABLE_MS = 60_000;

/**
 * A failure that a fresh connection can mend: the room could not be reached, or the connection broke. Never a camera
 * or microphone that cannot open (a DOMException such as NotAllowedError, NotFoundError or NotReadableError, or a
 * LiveKit track error), never our own remount or leave cancelling a connection ('Cancelled'), and never the server
 * telling us to leave ('LeaveRequest': the meeting ended, or another tab of this person took the place).
 */
export function isRetryableRoomError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { name, reasonName } = err as { name?: unknown; reasonName?: unknown };
  if (name !== 'ConnectionError') return false;
  return reasonName !== 'Cancelled' && reasonName !== 'LeaveRequest';
}
