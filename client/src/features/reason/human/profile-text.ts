// client/src/features/reason/human/profile-text.ts
// What the Human Profile says, and the small rules behind it. Pure on purpose (no React, axios, store or
// router), so a test can run it: server/src/__tests__/client/reason-m1-profile-text.test.ts.
import { OUTCOME_LABELS, type MatchStrength, type PersonBrief, type PersonResponse } from '@rsn/shared';
import { personName, visibleText } from '../person';
import { STATE_LABEL } from './labels';

export interface Row { title: string; text: string }

// ---- the address -----------------------------------------------------------------------------

// ?from= is part of the address, so anyone can write anything into it. Only the places the app itself sends a
// member from are ever shown on the page.
export const KNOWN_SOURCES = ['For You', 'People', 'Messages', 'Introductions', 'Your path'] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export function knownSource(from: string | null): KnownSource | null {
  return KNOWN_SOURCES.find((s) => s === from) ?? null;
}

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A member id, in either case. Anything else (a crafted address, a typo) is no member's, and needs no request. */
export const isMemberId = (id: string) => MEMBER_ID.test(id);

// ---- what a failed request says about the person ----------------------------------------------

export const statusOf = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } } | null | undefined)?.response?.status;

// 404: blocked, closed or no such member. 400: not a member id. Both are answers about this person.
// Anything else (no connection, 429, 5xx) says nothing about them, and Try again can help.
const GONE_STATUSES = [404, 400];

export const isGone = (err: unknown) => GONE_STATUSES.includes(statusOf(err) ?? 0);

export function isClientError(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && status >= 400 && status < 500;
}

/** A 4xx is an answer (blocked, closed, a bad id, slow down), so asking again changes nothing. A lost connection or a 5xx gets one more try. */
export const shouldRetry = (failures: number, err: unknown) => !isClientError(err) && failures < 1;

export interface LoadState {
  hasBrief: boolean;
  validId: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}
export type View = 'profile' | 'unavailable' | 'loading' | 'failed';

/**
 * Which screen the page shows for the state of its one query.
 * - "not available": an id that is no member's, or a 404 or 400, even over a profile already on screen (the
 *   person is gone).
 * - the profile: any brief at all. A refetch that fails, or is held back offline, leaves it standing.
 * - the skeleton: the first answer is on its way.
 * - "could not load": the first answer failed, or the library has PAUSED the request. Offline it holds a request
 *   back instead of failing it, so a skeleton would sit there until the connection returned.
 */
export function viewFor(q: LoadState): View {
  if (!q.validId || (q.isError && isGone(q.error))) return 'unavailable';
  if (q.hasBrief) return 'profile';
  if (q.isPending && q.fetchStatus !== 'paused') return 'loading';
  return 'failed';
}

// ---- the person ------------------------------------------------------------------------------

/** What the page shows about a person. Every text is trimmed and a blank one is null, so nothing blank is drawn. */
export interface PersonFacts {
  /** The heading. "Member" when the account has no name. */
  name: string;
  /** What a sentence calls them. */
  first: string;
  role: string | null;
  company: string | null;
  bio: string | null;
  tags: string[];
}

export function personFacts(p: PersonBrief['person']): PersonFacts {
  const name = personName(p.displayName);
  const roles = p.professionalRole.map(visibleText).filter((r): r is string => r !== null);
  return {
    name,
    first: visibleText(p.firstName) ?? name.split(' ')[0],
    role: roles.join(', ') || visibleText(p.jobTitle),
    company: visibleText(p.company),
    bio: visibleText(p.bio),
    tags: [visibleText(p.industry), ...roles].filter((t): t is string => t !== null).slice(0, 4),
  };
}

// ---- the reason, and where you found them -------------------------------------------------------

export const SIGNAL: Record<MatchStrength, string> = { strong: 'Strong reason', close: 'Worth exploring' };

/**
 * The dark panel's text. The brief scores the person's public card only, so someone For You listed for a
 * private interest can have no match here. The panel then says neither that there is a reason nor that there
 * is none.
 */
export function reasonText(brief: Pick<PersonBrief, 'match' | 'theyCanBring'>, first: string): string {
  const matched = visibleText(brief.match?.reason);
  if (matched) return matched;
  return visibleText(brief.theyCanBring)
    ? `Start with what ${first} can bring, and see whether there is a reason to meet.`
    : 'See what you have in common, and whether there is a reason to meet.';
}

const GENERIC_LINE = 'REASON explains why this person may matter to you right now.';

/** The small box under the name: the prototype's own "where you found them" copy, by source. */
export function foundThrough(source: KnownSource | null, first: string): { title: string; line: string } {
  switch (source) {
    case 'For You':
      return { title: `You found ${first} through For You`, line: `REASON surfaced ${first} because this relationship looks unusually relevant to what you are trying to make happen now.` };
    case 'People':
      return { title: `You found ${first} through People`, line: `You found ${first} while exploring the wider network. REASON still explains why this person may matter, rather than leaving you with a directory result.` };
    case 'Messages':
      return { title: `You found ${first} through Messages`, line: 'This profile is the relationship layer behind your conversation. The history, reason and next useful move travel with the message thread.' };
    case 'Introductions':
      return { title: `You found ${first} through Introductions`, line: 'This relationship arrived through an introduction. REASON keeps the introducer, reason and outcome as part of the relationship memory.' };
    case 'Your path':
      return { title: `You found ${first} on your path`, line: GENERIC_LINE };
    default:
      return { title: `About ${first}`, line: GENERIC_LINE };
  }
}

/** "Why now": the strength (only with a match), the source (only a known one) and the first shared event. */
export function whyNowRows(brief: Pick<PersonBrief, 'match' | 'shared'>, source: KnownSource | null): Row[] {
  const event = brief.shared.upcomingEvents[0];
  return [
    ...(brief.match ? [{ title: SIGNAL[brief.match.strength], text: 'REASON believes this is currently relevant.' }] : []),
    ...(source ? [{ title: source, text: 'This is the context where you encountered each other.' }] : []),
    ...(event ? [{ title: event.title, text: 'You will both be there.' }] : []),
  ];
}

// ---- relationship memory ----------------------------------------------------------------------

const WORTH_LABEL = { yes: 'Worth continuing', maybe: 'Maybe worth continuing', no: 'Not worth continuing' } as const;

export const metTitle = (timesMet: number) =>
  timesMet > 0 ? `You have met ${timesMet} time${timesMet === 1 ? '' : 's'}.` : 'You have not met yet.';

// A meeting can be on record without a date (a one to one meeting from Messages), so "no meeting recorded" is
// only said when there is none.
export function lastMetText(r: Pick<PersonBrief['relationship'], 'lastMetAt' | 'timesMet'>): string {
  if (r.lastMetAt) return `Last met ${new Date(r.lastMetAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}.`;
  return r.timesMet > 0 ? 'The date of your last meeting is not recorded.' : 'No meeting recorded yet.';
}

/** Where the relationship stands, then the newest recorded outcome (the brief lists them newest first). */
export function memoryRows(r: PersonBrief['relationship']): Row[] {
  const last = r.outcomes[0];
  return [
    { title: STATE_LABEL[r.state], text: lastMetText(r) },
    ...(last ? [{ title: WORTH_LABEL[last.worthContinuing], text: last.outcomes.length ? last.outcomes.map((k) => OUTCOME_LABELS[k]).join(', ') : 'Nothing noted.' }] : []),
  ];
}

// ---- Save and Pass ----------------------------------------------------------------------------

// What each press does. Clearing is the same request for "remove from saved" and "undo pass", so the move, not
// the response, decides the sentence.
export type Move = 'save' | 'unsave' | 'pass' | 'unpass';
export const MOVE_RESPONSE: Record<Move, PersonResponse | null> = { save: 'saved', unsave: null, pass: 'passed', unpass: null };

export function moveToast(move: Move, name: string): { message: string; type: 'success' | 'info' } {
  switch (move) {
    case 'save': return { message: `${name} saved`, type: 'success' };
    case 'unsave': return { message: `${name} removed from saved`, type: 'success' };
    case 'pass': return { message: `${name} will not be suggested in For You. You can undo this here.`, type: 'info' };
    case 'unpass': return { message: `${name} can be suggested in For You again.`, type: 'info' };
  }
}
