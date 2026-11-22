// client/src/features/sessions/waitlist/waitlist-text.ts
// Part 3 Task 8 (10 Nov 2026 spec 03, plan K3): what the waiting list says on the event page and on the organisers'
// card, and the small rules the screens read (when Register asks for the line, how a 202 is read). No imports but the
// shared package, so the server's test suite runs it.
//
// Attendees are told only that the event is full and their own number in the line, never how many places or people
// there are; the organisers read the line itself (GET /sessions/:id/waitlist).
import type { EventWaitlistAccess, WaitlistEntryCard, WaitlistJoinedVia } from '@rsn/shared';

export const WAITLIST_COPY = {
  full: 'This event is full.',
  join: 'Join the waiting list',
  onLine: (n: number) => `On the waiting list · number ${n}`,
  leave: 'Leave the waiting list',
  leaveTitle: 'Leave the waiting list?',
  leaveBody: "You'll lose your place in the line.",
  leftToast: 'You left the waiting list.',
  joinedToast: (n: number) => `This event is full. You're number ${n} on the waiting list.`,
  fullChip: 'Full',
  peopleLater: "You'll see who's coming once a place is yours.",
  cardTitle: 'Waiting list',
  count: (n: number) => (n === 1 ? '1 person waiting' : `${n} people waiting`),
  empty: 'Nobody is waiting.',
  letIn: 'Let in now',
  letInTitle: (name: string) => `Let ${name} in?`,
  letInBody: 'This goes over the capacity you set.',
  letInDone: (name: string) => `${name} has a place now.`,
  remove: 'Remove',
  removeTitle: (name: string) => `Take ${name} off the waiting list?`,
  removeBody: "They lose their place in the line and can't join it again.",
  removedToast: (name: string) => `${name} is off the waiting list.`,
  approvedQueued: (name: string, n: number) => `Approved. The event is full, so ${name} is number ${n} on the waiting list.`,
  error: 'The waiting list could not be read just now.',
  retry: 'Try again',
  fallback: 'That did not go through. Please try again.',
};

/** How a person reached the line, in words. */
export const JOINED_VIA_LABEL: Record<WaitlistJoinedVia, string> = {
  register: 'Joined on the event page',
  call_link: 'Joined through the event link',
  approval: 'Request approved',
  invite: 'Accepted an invite',
};

/** "Number 2 · Joined through the event link · Guest". */
export function waitlistRowLine(entry: Pick<WaitlistEntryCard, 'position' | 'joinedVia' | 'accountKind'>): string {
  const parts = [`Number ${entry.position}`, JOINED_VIA_LABEL[entry.joinedVia] ?? JOINED_VIA_LABEL.register];
  if (entry.accountKind === 'event_guest') parts.push('Guest');
  return parts.join(' · ');
}

/**
 * The body the event page's Register sends: `{ waitlist: true }` only when the server says the event is full, so a
 * full event queues the person (202) instead of refusing them. Otherwise nothing, exactly as before.
 */
export function registerBody(access: { waitlist?: EventWaitlistAccess } | undefined): { waitlist: true } | undefined {
  return access?.waitlist?.full ? { waitlist: true } : undefined;
}

interface RegisterAnswer {
  status: number;
  data?: { data?: unknown };
}

/** A 202 `{ waitlisted: true, position }` answer's place in the line; null for a place (201) or anything else. */
export function waitlistedPosition(res: RegisterAnswer): number | null {
  if (res.status !== 202) return null;
  const data = res.data?.data as { waitlisted?: unknown; position?: unknown } | undefined;
  return data?.waitlisted === true && typeof data.position === 'number' ? data.position : null;
}

/** The approve answer's `waitlistPosition`: the approval was given on a full event and queued the person. */
export function approvedQueuedPosition(data: unknown): number | null {
  const position = (data as { waitlistPosition?: unknown } | null | undefined)?.waitlistPosition;
  return typeof position === 'number' ? position : null;
}

/** The organisers' card shows itself once the event is full or someone is waiting (an event with room has no line). */
export function showsWaitlistCard(full: boolean, waiting: number): boolean {
  return full || waiting > 0;
}

/** A refusal (403) or an event that is gone (404): the card is not for this viewer, and it draws nothing. */
export function notForThisViewer(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404;
}

/** The server's own sentence for a failed press, or a plain one. */
export function waitlistFailure(err: unknown): string {
  const message = (err as { response?: { data?: { error?: { message?: string } } } } | null)?.response?.data?.error?.message;
  return message || WAITLIST_COPY.fallback;
}
