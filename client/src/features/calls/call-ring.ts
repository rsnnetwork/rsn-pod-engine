// ─── A ringing call, as this device holds it (1 Nov 2026, 30 Oct review item 4) ─────────────────────
// Pure on purpose (no axios, store or router), so a test can run it: server/src/__tests__/client/
// t9-direct-call.test.ts. The store (stores/callStore.ts) holds RingingCall; the routes are in call-api.ts.

import type { LiveCallRequest } from '@rsn/shared';
import { CONNECTION_LOST, memberSentence } from '../reason/errors';

export type CallKind = 'audio' | 'video';

export interface RingingCall {
  requestId: string;
  conversationId: string;
  /** The other person: the one ringing me, or the one I rang. */
  partnerId: string;
  partnerName: string;
  kind: CallKind;
  durationMin: number;
  /** When it lapses unanswered (ms since the epoch). */
  expiresAt: number;
  /** When this device learned of it, so a read that began before it cannot take it away again. */
  seenAt: number;
  /**
   * This tab rang it (finding F3, 2 Nov 2026). Every tab of the caller holds the call (the ring's tag reads it again
   * in each), but only the tab that rang goes into the room when it is answered: two tabs in one room with one identity
   * and LiveKit puts one of them out. A call read from the server was rung elsewhere unless this tab remembers ringing
   * it (placed-here.ts); a call ringing me is never placed here.
   */
  placedHere: boolean;
}

/** A call rings for two minutes, then lapses (the server's CALL_REQUEST_TTL_MS). */
export const CALL_RING_MS = 2 * 60 * 1000;

/** What a ring answers: the request, as both call routes return it. */
export interface RungRequest {
  id: string;
  conversationId: string;
  fromUserId: string;
  toUserId: string;
  kind: CallKind;
  durationMin: number;
  createdAt: string;
}

/** A live request the server read, as this device holds it. `seenAt` is when the read began. */
export function fromLive(live: LiveCallRequest, side: 'incoming' | 'outgoing', seenAt: number, placedHere = false): RingingCall {
  return {
    requestId: live.id,
    conversationId: live.conversationId,
    partnerId: side === 'incoming' ? live.fromUserId : live.toUserId,
    partnerName: live.partnerName,
    kind: live.kind,
    durationMin: live.durationMin,
    expiresAt: Date.parse(live.expiresAt),
    seenAt,
    placedHere: side === 'outgoing' && placedHere,
  };
}

/** The request a ring just made, as the caller's "Calling…" card shows it: placed in this tab. */
export function fromRung(rung: RungRequest, partnerName: string, now: number): RingingCall {
  return {
    requestId: rung.id,
    conversationId: rung.conversationId,
    partnerId: rung.toUserId,
    partnerName,
    kind: rung.kind,
    durationMin: rung.durationMin,
    expiresAt: Date.parse(rung.createdAt) + CALL_RING_MS,
    seenAt: now,
    placedHere: true,
  };
}

/**
 * What a read of the calls ringing now does to the one this device shows: `undefined` leaves it, `null` takes it
 * away, a call shows that call. A read brings a call back when it is not the one shown. It takes the shown one away
 * only when the device knew of it before the read began, so a read already on its way when a call rang cannot hide
 * the call again.
 */
export function reconcile(current: RingingCall | null, read: RingingCall | null, askedAt: number): RingingCall | null | undefined {
  if (read) return current?.requestId === read.requestId ? undefined : read;
  if (current && current.seenAt < askedAt) return null;
  return undefined;
}

/** The room a call opens: no countdown, it is happening now. */
export const callRoomPath = (conversationId: string, kind: CallKind) => `/meet/${conversationId}?kind=${kind}`;

/** The live room of an event (/session/:id/live), which answering a call leaves (final fix wave CM4, 2 Nov 2026). */
export const inLiveEvent = (pathname: string) => /^\/session\/[^/]+\/live\/?$/.test(pathname);

/** What the incoming call banner asks before answering takes the member out of a live event. */
export const LEAVE_EVENT_FOR_CALL = {
  question: 'Leave the event to take the call?',
  leave: 'Leave and answer',
  stay: 'Stay in the event',
} as const;

/** "1:59", "0:05". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface FailedCall { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown } } } }

/** The server's code for a refused ring: offline, one already ringing, or something else. */
export function refusalCode(err: unknown): string | null {
  const code = (err as FailedCall)?.response?.data?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * What a refused ring, answer or decline says. The server's refusals are sentences written for members ("Bo isn't
 * online right now. Send a message instead.", "You cannot call this member."), its rate limit included, so they are
 * shown as they are; anything else, or nothing at all, gets a plain sentence.
 */
export function ringRefusal(err: unknown): string {
  const response = (err as FailedCall)?.response;
  if (!response) return CONNECTION_LOST;
  return memberSentence(response.data?.error?.message) ?? 'Could not ring them just now. Try again in a moment.';
}
