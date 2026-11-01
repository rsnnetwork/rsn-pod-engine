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
export const withdrawCall = (requestId: string) => api.post(`/dm/call/requests/${encodeURIComponent(requestId)}/cancel`);

export const fetchIncomingCall = () =>
  api.get('/dm/call/requests/incoming').then((r) => r.data.data as LiveCallRequest | null);
export const fetchOutgoingCall = () =>
  api.get('/dm/call/requests/outgoing').then((r) => r.data.data as LiveCallRequest | null);
