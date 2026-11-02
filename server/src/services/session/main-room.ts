// ─── The main room a LiveKit token names (2 Nov 2026) ───────────────────────────────────────────
//
// Every path that sends someone to an event's main room sends them to `lobby-<id>` (video.service). A token
// minted while the event row held no lobby room id (the Start gap, a REST start, a failed room write) used to
// name `session-<id>`, a room nobody else is ever sent to, and the person sat alone in it.

import { SessionStatus } from '@rsn/shared';
import { lobbyRoomId } from '../video/video.service';

/** The states an event is live in (started, not yet over). */
export const LIVE_STATUSES: readonly SessionStatus[] = [
  SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING,
  SessionStatus.ROUND_TRANSITION, SessionStatus.CLOSING_LOBBY,
];

export function isLiveStatus(status: string | null | undefined): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status ?? '');
}

/** The stored lobby room id, else the lobby everyone else is sent to. */
export function mainRoomOf(sessionId: string, storedLobbyRoomId: string | null | undefined): string {
  return storedLobbyRoomId || lobbyRoomId(sessionId);
}

/**
 * The main room for a live event; nothing before Go Live or after the end, unless a lobby room id is stored
 * (the resync rail has never minted a main-room token outside a live event, and still does not).
 */
export function liveMainRoomOf(
  sessionId: string,
  session: { status: string; lobbyRoomId?: string | null },
): string | undefined {
  if (session.lobbyRoomId) return session.lobbyRoomId;
  return isLiveStatus(session.status) ? lobbyRoomId(sessionId) : undefined;
}
