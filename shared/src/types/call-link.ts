// ─── The RSN Call link: what its screens read (Part 2 foundation, Task 6; spec 02, 04) ─────────────────
//
// Open the link, verify an email with a 6-digit code, give only what the event still needs, enter. The landing never
// carries the event's participants, its pod or its invitees: only what someone holding the link may see.

import type { EventFormat } from '../events/definitions';
import type { EventLifecycle } from '../events/lifecycle';
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
 */
export type CallEntryStep =
  | 'identify' | 'details' | 'request' | 'pending_approval' | 'declined'
  | 'enter' | 'wait_for_start' | 'ended' | 'cancelled' | 'refused';

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
  durationMinutes: number;
  format: EventFormat;
  host: { displayName: string; avatarUrl: string | null };
  lifecycle: EventLifecycle;
  admission: EffectiveAdmission;
  /** What the event may ask for before someone enters. */
  asks: { displayName: boolean; group: CallLandingGroupAsk | null; admissionCode: boolean };
  /** `sessionId` only for a signed-in viewer who holds a place or runs the event. */
  viewer: { signedIn: boolean; accountKind: AccountKind | null; sessionId: string | null; step: CallEntryStep };
}

/** A signed-in person's state on an event's link, and the answer to entering it. */
export interface CallEntryState {
  step: CallEntryStep;
  /** The event's id, once they hold a place, have asked for one, or run it. */
  sessionId: string | null;
  /** Where to go in, when `step` is 'enter'. */
  livePath: string | null;
  missing: { displayName: boolean; group: boolean; admissionCode: boolean };
  refusal: { code: string; message: string } | null;
  startsAt: string | null;
}

/** One of a person's events reached by its link (their place or their request), for the guest home. */
export interface CallEventSummary {
  code: string;
  title: string;
  scheduledAt: string | null;
  lifecycle: EventLifecycle;
  step: CallEntryStep;
}

/** What verifying the code (or the email's link) gives: a session, and whether a guest account was just made. */
export interface CallEntryVerification {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountKind: AccountKind;
  created: boolean;
}
