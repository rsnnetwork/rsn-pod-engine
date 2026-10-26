// client/src/features/messages/request-answer.ts
// A meeting request's answer, as every surface draws it (26 Oct 2026). Pure on purpose (no React, axios, store or
// router), so a test can run it: server/src/__tests__/client/notification-bell-panel.test.ts.
//
// The request row on the server is the only state. On 25 Oct Claus accepted on the Messages card, opened the bell, and
// its entry still offered Accept: the bell drew an answer it had kept in its own memory, and forgot it on every fetch.
// Now every surface draws what the server says (GET /notifications carries `requestState` on each `poke` row), and the
// three places a request can be answered share one mutation key per request.

export type Answer = 'accept' | 'decline';

/** Where a request stands, as GET /notifications sends it on a `poke` row. */
export interface RequestStateLike { status: string; conversationId: string | null }

/**
 * One mutation key per request. The bell, the Messages list card and the focused card all answer through it, so
 * while any one of them is answering, the others know (useMutationState) and offer no second answer.
 */
export function requestAnswerKey(requestId: string): readonly ['request-answer', string] {
  return ['request-answer', requestId] as const;
}

// The link a request's bell row carries: /messages?poke=<a whole uuid>, nothing after it.
const REQUEST_LINK = /^\/messages\?poke=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The request a bell row's link names, or null. */
export function requestIdFromLink(link: string | null | undefined): string | null {
  return link ? REQUEST_LINK.exec(link)?.[1] ?? null : null;
}

export interface BellRequestView {
  requestId: string;
  /** Accept and Decline are offered: the request is still waiting for an answer. */
  canAnswer: boolean;
  label: 'Accepted' | 'Declined' | null;
  /** Where the row's title goes: the conversation once accepted, else the request itself. */
  destination: string;
}

/**
 * How a `poke` row in the bell draws, from what the server says. `requestState` is null when the request is gone (or
 * was never this member's), and then nothing is offered. A server from before 25 Oct sends no `requestState`; its
 * `pokeStatus` (production's own bell reads it) stands in.
 */
export function bellRequestView(n: {
  type: string; link?: string | null; requestState?: RequestStateLike | null; pokeStatus?: string | null;
}): BellRequestView | null {
  if (n.type !== 'poke') return null;
  const requestId = requestIdFromLink(n.link);
  if (!requestId) return null;
  const destination = `/messages?poke=${requestId}`;
  const status = n.requestState === undefined ? (n.pokeStatus ?? 'pending') : n.requestState?.status ?? null;
  if (status === 'pending') return { requestId, canAnswer: true, label: null, destination };
  if (status === 'accepted') {
    const conversationId = n.requestState?.conversationId ?? null;
    return { requestId, canAnswer: false, label: 'Accepted', destination: conversationId ? `/messages/${conversationId}` : destination };
  }
  if (status === 'declined') return { requestId, canAnswer: false, label: 'Declined', destination };
  return { requestId, canAnswer: false, label: null, destination };
}

/** "You already accepted this request." */
export function alreadyAnsweredMessage(status: 'accepted' | 'declined'): string {
  return `You already ${status} this request.`;
}

interface FailedAnswer {
  response?: { status?: number; data?: { error?: { code?: unknown; details?: { status?: unknown } } } };
}

/**
 * The 409 for a request answered the other way already (in another tab, on another device, or on another surface
 * here), with the answer it has. Answering the SAME way twice is not this: the server answers that with a 200.
 */
export function alreadyAnswered(err: unknown): { status: 'accepted' | 'declined'; message: string } | null {
  const response = (err as FailedAnswer | null | undefined)?.response;
  if (response?.status !== 409 || response.data?.error?.code !== 'MEETING_REQUEST_ALREADY_ANSWERED') return null;
  const status = response.data.error.details?.status;
  return status === 'accepted' || status === 'declined' ? { status, message: alreadyAnsweredMessage(status) } : null;
}
