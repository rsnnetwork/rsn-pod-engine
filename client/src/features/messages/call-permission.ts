// client/src/features/messages/call-permission.ts
// Whether this conversation's call may go on (S5 fix 6, 12 Nov 2026). A block made during a call ends it for both
// people. The server closes the call's room, and LiveKit then disconnects both with ROOM_DELETED. On production that
// signal did not always come (LiveKit answered "room not found" for a room started half a second before the block), and
// the person stayed in a dead call. So the call page also asks the server itself: when the block's own change arrives
// (user:<me>:blocks, sent to both people), and when the room disconnects for any other reason.
//
// The one source of truth is the server's call permission, the check that mints a call token (requireCallParticipant):
// GET /dm/conversations/:id/partner-presence answers through it, and refuses (403) once either has blocked the other.
// Pure on purpose: server/src/__tests__/client/shirley-s5-safety-calls.test.ts.
import { DisconnectReason } from 'livekit-client';
import api from '@/lib/api';

/** allowed: the call may go on. refused: it may not (a block either way, or no longer theirs). unknown: no answer. */
export type CallPermission = 'allowed' | 'refused' | 'unknown';

/** The permission an answer's HTTP status gives. Only a refusal ends the call; a failed read never does. */
export function permissionFromStatus(status: number | undefined): CallPermission {
  if (status === undefined) return 'unknown';
  if (status >= 200 && status < 300) return 'allowed';
  if (status === 403 || status === 404) return 'refused';
  return 'unknown';
}

/** How long the read after a disconnect is waited on before the page leaves the ordinary way. */
export const PERMISSION_READ_MS = 3_000;

/** The server's answer for this conversation's call now. Never rejects. */
export async function readCallPermission(conversationId: string): Promise<CallPermission> {
  try {
    const r = await api.get(`/dm/conversations/${encodeURIComponent(conversationId)}/partner-presence`);
    return permissionFromStatus(r.status);
  } catch (err) {
    return permissionFromStatus((err as { response?: { status?: number } } | null)?.response?.status);
  }
}

/** readCallPermission, or 'unknown' once `ms` have passed. */
export function readCallPermissionWithin(conversationId: string, ms = PERMISSION_READ_MS): Promise<CallPermission> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<CallPermission>((resolve) => { timer = setTimeout(() => resolve('unknown'), ms); });
  return Promise.race([readCallPermission(conversationId), gaveUp]).finally(() => clearTimeout(timer));
}

/**
 * Where a disconnect from the room leads. 'closed': back to the thread with "The call has ended." and no question about
 * the meeting (the room was closed under both people, or the call is no longer allowed). 'leave': the ordinary leave.
 */
export function afterDisconnect(reason: DisconnectReason | undefined, permission: CallPermission): 'closed' | 'leave' {
  if (reason === DisconnectReason.ROOM_DELETED) return 'closed';
  return permission === 'refused' ? 'closed' : 'leave';
}
