// ─── The call routes, as the call screens use them (1 Nov 2026) ─────────────────────────────────────
// A profile rings a person (POST /calls/user/:userId, video only); a thread rings its conversation
// (POST /dm/conversations/:id/call/request, video or audio). Both answer with the request. The answer, the
// decline and the withdraw go by request id. GET /dm/call/requests/incoming and /outgoing are the calls ringing
// now, from either side, for a screen opened or refreshed while one rings.

import type { LiveCallRequest } from '@rsn/shared';
import api from '@/lib/api';
import type { CallKind, RungRequest } from './call-ring';

/** Who is rung: a person (from their profile) or a conversation (from its thread). */
export type CallTarget = { userId: string; conversationId?: undefined } | { conversationId: string; userId?: undefined };

export async function ringCall(target: CallTarget, kind: CallKind, durationMin: number): Promise<RungRequest> {
  const { data } = target.userId
    ? await api.post(`/calls/user/${encodeURIComponent(target.userId)}`, { kind: 'video', durationMin })
    : await api.post(`/dm/conversations/${encodeURIComponent(target.conversationId!)}/call/request`, { kind, durationMin });
  return data.data as RungRequest;
}

export const answerCall = (requestId: string) => api.post(`/dm/call/requests/${encodeURIComponent(requestId)}/accept`);
export const declineCall = (requestId: string) => api.post(`/dm/call/requests/${encodeURIComponent(requestId)}/decline`);
/** What a withdraw ended as: cancelled, or whatever answered first ("accepted": the callee is in the room). */
export interface WithdrawOutcome { status: string; conversationId: string; kind: CallKind }
export const withdrawCall = (requestId: string) =>
  api.post(`/dm/call/requests/${encodeURIComponent(requestId)}/cancel`).then((r) => r.data.data as WithdrawOutcome);

/**
 * I have left this conversation's call on purpose (fix round 3, 2 Nov 2026): our server takes this connection (its
 * LiveKit participant sid) out of the room, so the other person is told even when the leave my browser sent never
 * reached LiveKit. Not waited on, and a failure is let go on purpose: it is a second way to the same end, the room's
 * goodbye and LiveKit's own leave having been sent already, and the person has left either way.
 */
export function leftCallRoom(conversationId: string, sid: string): void {
  void api.post(`/dm/conversations/${encodeURIComponent(conversationId)}/call/leave`, { sid }).catch(() => undefined);
}

export const fetchIncomingCall = () =>
  api.get('/dm/call/requests/incoming').then((r) => r.data.data as LiveCallRequest | null);
export const fetchOutgoingCall = () =>
  api.get('/dm/call/requests/outgoing').then((r) => r.data.data as LiveCallRequest | null);
