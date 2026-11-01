// ─── How a breakout room recovers from a dropped or failed connection ───────────────────────────────
//
// A dropped room is retried twice, waiting a little longer each time (the token is fetched again and
// the room remounts), and after that the person goes back to the main room instead of looping. Both
// the plan and the budget live here so VideoRoom has no counting of its own.

export const ROOM_RETRY_DELAYS_MS = [2000, 4000];

/** How long to wait before giving up on a room that has used all its retries. */
const GIVE_UP_DELAY_MS = 2000;

export type RoomRecovery = { kind: 'retry'; delayMs: number } | { kind: 'lobby'; delayMs: number };

/** What to do next after `attemptsMade` retries of this room have already been made. */
export function planRoomRecovery(attemptsMade: number): RoomRecovery {
  if (attemptsMade < ROOM_RETRY_DELAYS_MS.length) return { kind: 'retry', delayMs: ROOM_RETRY_DELAYS_MS[attemptsMade] };
  return { kind: 'lobby', delayMs: GIVE_UP_DELAY_MS };
}
