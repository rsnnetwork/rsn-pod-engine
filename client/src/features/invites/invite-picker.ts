// ─── Inviting people from your connections: what the picker says and decides (26 Oct 2026, C9, POD-02/04) ───
//
// 25 Oct walkthrough: Stefan, inviting to a pod: "I may have 400 friends. I can't remember that he's called Claus."
// The old modals searched only event encounters, after a letter was typed, 20 at most, sent one request per person,
// and showed the result only on the page behind them. The server (S7) now lists an organiser's connections, or an
// event's pod, with where each person stands against the pod or event, a page at a time, and takes up to 50 people
// in one call. This turns its answers into what the invite sheet shows and says.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/c9-invite-picker.test.ts.
import { z } from 'zod';
import type {
  InviteBatchInput, InviteBatchOutcome, InviteBatchResponse, InviteCandidate, InviteCandidateSource, InviteCandidateState,
} from '@rsn/shared';
import { E } from '../../realtime/entities';
import { CONNECTION_LOST, memberSentence } from '../reason/errors';

/** What the sheet invites to: a pod, or an event (which lives in a pod; podId is null only while that is unknown). */
export type InviteTarget =
  | { type: 'pod'; podId: string }
  | { type: 'session'; sessionId: string; podId: string | null };

/** Your connections come 30 at a time, with "Show more" (the server's own page size). */
export const CONNECTIONS_PAGE = 30;
/** An event's pod comes 50 at a time, the most the server gives, so a Reason pod of 5 to 12 is one page… */
export const POD_PAGE = 50;
/** …and the sheet reads a pod of up to 200 to its end, so "This pod ({n})" and "Invite everyone ({n})" are exact. */
export const POD_PAGES_MAX = 4;
/** The server takes at most 50 people in one batch. */
export const BATCH_MAX = 50;
/** Chosen people shown as chips before the rest fold into "+N". */
export const CHIPS_SHOWN = 3;
/** A shareable link whose pod or event sets no capacity lets this many people in. */
export const LINK_CAP_DEFAULT = 500;
/** An email invite and a link last a week, as the pod and event pages always made them. */
const INVITE_HOURS = 168;

export const SEARCH_PLACEHOLDER = 'Search by name, role or company';
export const YOUR_CONNECTIONS = 'Your connections';
export const SHOW_MORE = 'Show more';
export const DONE = 'Done';
export const INVITE_BY_EMAIL = 'Invite by email';
export const SHARE_A_LINK = 'Share a link';
export const BATCH_FULL = `You can invite up to ${BATCH_MAX} people at a time.`;
export const NOT_SENT = 'Those invitations could not be sent. Try again.';
export const LINK_NOT_MADE = 'The link could not be made. Try again.';
export const LOAD_MORE_FAILED = 'We could not load more just now. Try again.';

/** "1 person", "2 people". */
export function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** The sheet is called what its button on the page is called. */
export function pickerTitle(target: InviteTarget): string {
  return target.type === 'pod' ? 'Invite members' : 'Invite people';
}

const typed = (target: InviteTarget) =>
  target.type === 'pod' ? { type: 'pod' as const, podId: target.podId } : { type: 'session' as const, sessionId: target.sessionId };

// ─── What is asked of the server ──────────────────────────────────────────────────────────────────

/** GET /invites/candidates: the pod or event, the list, the trimmed search (none to browse), the page already shown. */
export function candidateParams(
  target: InviteTarget,
  source: InviteCandidateSource,
  q: string,
  before: string | null,
): Record<string, string | number> {
  const params: Record<string, string | number> = { source, limit: source === 'pod' ? POD_PAGE : CONNECTIONS_PAGE };
  if (target.type === 'pod') params.podId = target.podId;
  else params.sessionId = target.sessionId;
  const words = q.trim();
  if (words) params.q = words;
  if (before) params.before = before;
  return params;
}

/** The tags the server's fan-out sends when an invite to this pod or event is made, answered or withdrawn. */
export function targetTags(target: InviteTarget): string[] {
  return target.type === 'pod'
    ? [E.pod(target.podId), E.podMembers(target.podId), E.podInvites(target.podId)]
    : [E.session(target.sessionId), E.sessionParticipants(target.sessionId), E.sessionInvites(target.sessionId)];
}

/**
 * What a candidates list follows: the pod or event (an invite made, accepted, declined or withdrawn; someone joining),
 * the event's pod when the list is its members, and the member's own connections (a request accepted, a conversation
 * started) and blocks (either way), which change who is listed at all.
 */
export function candidateEntities(target: InviteTarget, source: InviteCandidateSource, me: string | undefined): string[] {
  const tags = targetTags(target);
  if (source === 'pod' && target.type === 'session' && target.podId) tags.push(E.podMembers(target.podId));
  if (me) tags.push(...(source === 'connections' ? [E.user(me), E.userInvites(me), E.userDms(me), E.userBlocks(me)] : [E.userBlocks(me)]));
  return tags;
}

/** POST /invites/batch: people by id, never by address; "everyone in the pod" only for an event. */
export function batchBody(target: InviteTarget, inviteeUserIds: string[], allPodMembers = false): InviteBatchInput {
  const body: InviteBatchInput = { ...typed(target), inviteeUserIds };
  return allPodMembers ? { ...body, allPodMembers: true } : body;
}

/** POST /invites for one address: one use, a week long. */
export function emailInviteBody(target: InviteTarget, email: string) {
  return { ...typed(target), inviteeEmail: email.trim(), maxUses: 1, expiresInHours: INVITE_HOURS };
}

/** How many people a shareable link lets in: the pod's or event's capacity, or 500 when it sets none. */
export function linkCap(cap: number | null | undefined): number {
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : LINK_CAP_DEFAULT;
}

/** POST /invites for a shareable link (no address): the real cap, a week long. */
export function linkBody(target: InviteTarget, cap: number) {
  return { ...typed(target), maxUses: cap, expiresInHours: INVITE_HOURS };
}

/** What the link allows, said before it is made and beside it after. */
export function shareLinkNote(target: InviteTarget, cap: number): string {
  return `Anyone with this link can join the ${target.type === 'pod' ? 'pod' : 'event'}, up to ${people(cap)}, for 7 days.`;
}

/** The email form: each problem at the field, in words (lib/form-resolver.ts). */
export const emailSchema = z.object({
  email: z.string().trim().min(1, 'Enter their email address').email('Enter a whole email address, like name@example.com'),
});
export type EmailValues = z.infer<typeof emailSchema>;

// ─── What a row and the footer say ────────────────────────────────────────────────────────────────

const STATE_LABELS: Record<InviteCandidateState, string | null> = {
  available: null, member: 'Member', going: 'Going', invited: 'Invited', declined: 'Declined',
};

/** The badge on a row; an available person has none. */
export function stateLabel(state: InviteCandidateState): string | null {
  return STATE_LABELS[state];
}

/** Only someone available can be picked; the others stay listed, unpickable, so where they stand can be read. */
export function canPick(state: InviteCandidateState): boolean {
  return state === 'available';
}

/** Where a person stands once a batch has answered for them, as the server will say when the list is read again. */
export function stateAfter(outcome: InviteBatchOutcome): InviteCandidateState | null {
  switch (outcome) {
    case 'invited':
    case 'already_invited':
      return 'invited';
    case 'already_member':
      return 'member';
    case 'already_going':
      return 'going';
    case 'declined':
      return 'declined';
    default:
      return null;
  }
}

/**
 * A row's state: the server's, except that someone the server still lists as available just after a batch answered
 * for them reads as that answer said, so the row changes in place at once rather than when the list is read again.
 */
export function effectiveState(person: InviteCandidate, sent: ReadonlyMap<string, InviteCandidateState>): InviteCandidateState {
  return person.state === 'available' ? sent.get(person.userId) ?? 'available' : person.state;
}

/** The footer button: "Send 1 invite", "Send 5 invites", "Send invites" while nobody is chosen. */
export function sendLabel(n: number): string {
  if (n === 0) return 'Send invites';
  return n === 1 ? 'Send 1 invite' : `Send ${n} invites`;
}

/** A count that is exact once the list is read to its end, and "200+" while it is not. */
export function countLabel(n: number, complete: boolean): string {
  return complete ? `${n}` : `${n}+`;
}

/** The pod segment: "This pod (8)", or "This pod" while its members are on their way. */
export function podSegmentLabel(count: string | null): string {
  return count ? `This pod (${count})` : 'This pod';
}

export function inviteEveryoneLabel(podName: string | undefined, count: string): string {
  return `Invite everyone in ${podName || 'the pod'} (${count})`;
}

/** The chips drawn: the first three and "+N" for the rest, or all of them once opened. */
export function chipsView<T>(chosen: readonly T[], expanded: boolean): { chips: T[]; more: number } {
  if (expanded || chosen.length <= CHIPS_SHOWN) return { chips: [...chosen], more: 0 };
  return { chips: chosen.slice(0, CHIPS_SHOWN), more: chosen.length - CHIPS_SHOWN };
}

/** The people of every page loaded so far, each once (two pages read at different times can share someone). */
export function everyoneOnce(pages: ReadonlyArray<{ items: InviteCandidate[] }>): InviteCandidate[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.items).filter((person) => !seen.has(person.userId) && !!seen.add(person.userId));
}

// ─── What is said afterwards ──────────────────────────────────────────────────────────────────────

export interface Notice {
  message: string;
  tone: 'success' | 'info' | 'error';
}

const is = (n: number) => (n === 1 ? 'is' : 'are');
const was = (n: number) => (n === 1 ? 'was' : 'were');

/**
 * A batch's answer as one toast. "Invitations sent" is what the server promises when it answers (each invite exists
 * and its bell has gone; the emails follow, two a second), so it never says the emails were sent.
 */
export function batchSentence(res: InviteBatchResponse): Notice {
  const c = res.counts;
  const parts: string[] = [];
  if (c.invited > 0) parts.push(c.invited === 1 ? '1 invitation sent.' : `${c.invited} invitations sent.`);
  if (c.already_invited > 0) parts.push(`${people(c.already_invited)} ${was(c.already_invited)} already invited.`);
  if (c.already_member > 0) parts.push(`${people(c.already_member)} ${is(c.already_member)} already in the pod.`);
  if (c.already_going > 0) parts.push(`${people(c.already_going)} ${is(c.already_going)} already going.`);
  if (c.declined > 0) parts.push(`${people(c.declined)} declined an earlier invitation.`);
  if (c.not_allowed > 0) parts.push(`${people(c.not_allowed)} can't be invited.`);
  if (c.failed > 0) parts.push(c.failed === 1 ? '1 invitation could not be sent. Try again.' : `${c.failed} invitations could not be sent. Try again.`);
  const left = res.remaining ?? 0;
  if (left > 0) parts.push(`${left} more ${left === 1 ? 'person' : 'people'} in the pod can still be invited.`);
  if (parts.length === 0) return { message: 'Nobody new to invite.', tone: 'info' };
  const tone = c.invited > 0 && parts.length === 1 ? 'success' : c.failed > 0 && c.invited === 0 ? 'error' : 'info';
  return { message: parts.join(' '), tone };
}

interface FailedCall {
  isAxiosError?: unknown;
  request?: unknown;
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

/** Validation details are { field: [messages] }: the first message of the first field that has one. */
function firstDetail(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  for (const messages of Object.values(details)) {
    if (!Array.isArray(messages)) continue;
    const first = messages.find((m): m is string => typeof m === 'string' && m.trim() !== '');
    if (first !== undefined) return first;
  }
  return undefined;
}

// The refusals the invite routes word for members: a closed pod or event, not allowed here, nobody there, a person who
// cannot be invited, an allowance used up, a reminder the mail provider did not take.
const SAID_TO_MEMBERS = new Set([400, 403, 404, 409, 429, 503]);

/** A failed invite call in the server's own sentence when it is one a member can read, else `fallback`. */
export function inviteErrorSentence(err: unknown, fallback: string): string {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as FailedCall;
  const response = failed.response;
  if (!response) return failed.isAxiosError === true || failed.request != null ? CONNECTION_LOST : fallback;
  const error = response.data?.error;
  if (response.status === 400 && error?.details != null) return memberSentence(firstDetail(error.details)) ?? fallback;
  return response.status !== undefined && SAID_TO_MEMBERS.has(response.status) ? memberSentence(error?.message) ?? fallback : fallback;
}
