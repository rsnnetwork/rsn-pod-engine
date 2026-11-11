// ─── The RSN Call link: what its screens read (Part 2 foundation, Task 6; spec 02, 04) ─────────────────
//
// Open the link, verify an email with a 6-digit code, give only what the event still needs, enter. The landing never
// carries the event's participants, its pod or its invitees: only what someone holding the link may see.

import type { EventFormat } from '../events/definitions';
import type { EventLifecycle } from '../events/lifecycle';
import type { EventMatchingQuestion } from '../events/matching-questions';
import type { EffectiveAdmission } from './session';
import type { AccountKind } from './user';

/**
 * Where a person stands on an event's link:
 *   identify          not signed in: give an email and the code sent to it
 *   details           signed in without a place: what the event still needs (`missing`); nothing missing = ready to enter
 *   request           the event asks its organisers to approve each place; entering sends the request
 *   pending_approval  their request waits for the organisers
 *   declined          the organisers declined their request
 *   enter             they hold a place and the event is live: go in (`livePath`)
 *   wait_for_start    they hold a place and the event has not started
 *   ended             the event is over
 *   cancelled         the event was cancelled
 *   refused           they may not take a place (`refusal` says why), e.g. the host removed them
 *   waitlisted        the event is full and they are on its waiting list (`waitlistPosition`, 1 = next); the first in
 *                     line is given the next place that frees (Part 3 Task 3)
 */
export type CallEntryStep =
  | 'identify' | 'details' | 'request' | 'pending_approval' | 'declined'
  | 'enter' | 'wait_for_start' | 'ended' | 'cancelled' | 'refused' | 'waitlisted';

/** The question an event with matching groups asks, and its answers. */
export interface CallLandingGroupAsk {
  question: string;
  options: Array<{ key: string; label: string }>;
  multiple: boolean;
}

/** What anyone holding an event's call link sees. */
export interface CallLanding {
  code: string;
  title: string;
  description: string | null;
  scheduledAt: string | null;
  /** Part 3 Task 1 — the event's IANA zone: the landing prints its times on this clock, named. */
  timezone: string;
  /** Part 3 Task 1 — the event's image (absolute), or null. */
  imageUrl: string | null;
  durationMinutes: number;
  format: EventFormat;
  host: { displayName: string; avatarUrl: string | null };
  lifecycle: EventLifecycle;
  admission: EffectiveAdmission;
  /**
   * What the event may ask for before someone enters. Part 3 Task 5: `questions` are the event's extra matching questions
   * this viewer has not answered, required ones first (signed out: all of them), or null when there are none to ask.
   * Never anyone's answers.
   */
  asks: {
    displayName: boolean; group: CallLandingGroupAsk | null; admissionCode: boolean; questions: EventMatchingQuestion[] | null;
  };
  /** `sessionId` only for a signed-in viewer who holds a place or runs the event. */
  viewer: { signedIn: boolean; accountKind: AccountKind | null; sessionId: string | null; step: CallEntryStep };
  /**
   * The event link as it is now (absent on an older server): the page puts it in the address bar, so a call link or an
   * event link the event has since changed shows the one to share. The path of `code` above when that is the event link.
   */
  link?: { slug: string; path: string };
}

/** A signed-in person's state on an event's link, and the answer to entering it. */
export interface CallEntryState {
  step: CallEntryStep;
  /** The event's id, once they hold a place, have asked for one, or run it. */
  sessionId: string | null;
  /** Where to go in, when `step` is 'enter'. */
  livePath: string | null;
  /** Part 3 Task 5: `questions` is a required matching question they have not answered (asked on approval events too). */
  missing: { displayName: boolean; group: boolean; admissionCode: boolean; questions: boolean };
  refusal: { code: string; message: string } | null;
  startsAt: string | null;
  /** Part 3 Task 3: their place in the event's waiting list (1 = next) when `step` is 'waitlisted', else null. */
  waitlistPosition: number | null;
}

/** True when the event still needs something from the person before a place (or a request). */
export function somethingMissing(missing: CallEntryState['missing']): boolean {
  return missing.displayName || missing.group || missing.admissionCode || missing.questions;
}

/** One of a person's events reached by its link (their place or their request), for the guest home. */
export interface CallEventSummary {
  code: string;
  title: string;
  scheduledAt: string | null;
  /** Part 3 Task 1 — the event's IANA zone. */
  timezone: string;
  /** Part 3 Task 1 — the event's image (absolute), or null. */
  imageUrl: string | null;
  lifecycle: EventLifecycle;
  step: CallEntryStep;
  /** The event link's path (e.g. '/events/rsn-3'), or null on an older server: where the guest home opens the event. */
  linkPath?: string | null;
}

/** What verifying the code (or the email's link) gives: a session, and whether a guest account was just made. */
export interface CallEntryVerification {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountKind: AccountKind;
  created: boolean;
}

/**
 * GET /sessions/:id/call-link, for the event's organisers: the call link (`code`, `path`, `url`, as before) and the event
 * link. `eventLink.url` is the address to show and copy: EVENT_LINK_BASE_URL on the server when it is set, else the site
 * the organiser asked from (one of ours), else the main app.
 */
export interface EventLinksForOrganiser {
  code: string;
  path: string;
  url: string;
  eventLink?: EventLinkInfo;
}

/** An event's link as its organisers see it. */
export interface EventLinkInfo {
  /** The name part, e.g. 'rsn'. */
  name: string;
  /** The number under that name. */
  number: number;
  /** e.g. 'rsn-3' or 'rsn-3-k7m2q9'. */
  slug: string;
  /** e.g. '/events/rsn-3'. */
  path: string;
  url: string;
  /** True when the link carries a random tail (a private, invitation-only or closed-circle event). */
  private: boolean;
}

/** GET /sessions/event-link-name: what the event form shows under its link-name field. */
export interface EventLinkNameCheck {
  /** The name an event gets when its organiser leaves the field empty. */
  defaultName: string;
  /** The name checked (trimmed, lower-cased), or the default when none was sent. */
  name: string;
  /** Why the name cannot be used, or null. */
  problem: string | null;
  /** The number the event would most likely get (another event may take it first), or null with a problem. */
  nextNumber: number | null;
  /** The address the link would have, without its tail: e.g. 'https://app.rsn.network/events/rsn-9', or null. */
  preview: string | null;
  /** True when this event (or, creating one, the visibility sent) gets a random tail. */
  private: boolean;
}
