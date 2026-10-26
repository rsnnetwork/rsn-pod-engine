// ─── "Message everyone who took part": what the panel says and does (26 Oct 2026, C10, COM-03) ───
//
// 25 Oct walkthrough: Claus, a plain member who hosted the finished event and directs its pod, found "Message all
// participants" greyed out, with its reason in a hover title a phone never shows; and even enabled it would have
// sent a fixed survey to nobody. Version 2 of the server (S6) lets the people who run an event write to everyone
// who took part once it has ended, and gives the state as a sentence. This turns its answer (and the latest send)
// into what the panel shows: the state always as text, the button only when a send would be accepted.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/c10-after-event.test.ts.
import { z } from 'zod';
import { POST_EVENT_MESSAGE_LIMITS } from '@rsn/shared';
import type { BroadcastAudience, BroadcastEligibilityV2, PostEventMessageJob } from '@rsn/shared';
import { CONNECTION_LOST, memberSentence } from '../reason/errors';

export const PANEL_TITLE = 'Message everyone who took part';
export const PANEL_INTRO = 'Each person gets your message privately, from you, in Messages. Their replies come to you alone.';
export const WRITE_MESSAGE = 'Write a message';
export const SEND_ANOTHER = 'Send another message';
export const LAST_SEND_FAILED = 'Your last message could not be sent.';
export const CHECK_FAILED = "We couldn't check whether you can message everyone.";
export const NOT_SENT = 'Your message could not be sent. Try again.';
export const MESSAGE_LABEL = 'Your message';
export const TOOK_PART_LABEL = 'Everyone who took part';
export const NO_SHOWS_LABEL = 'Also people who registered but did not come';
// The server's own sentences for the same two problems (routes/post-event-message.ts), so the form and a refusal agree.
export const WRITE_FIRST = 'Write a message first.';
export const BODY_TOO_LONG = `Messages can be up to ${POST_EVENT_MESSAGE_LIMITS.bodyMax} characters.`;

/** "1 person", "2 people". */
export function people(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** The day a message went out, the way the event page writes dates ("26 Oct 2026"). */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Sent to 2 people on 26 Oct 2026". */
export function sentSentence(recipients: number, at: string): string {
  return `Sent to ${people(recipients)} on ${day(at)}`;
}

/**
 * "You can send another message at 14:20." in the reader's own clock. The server writes the time in the sender's
 * stored time zone and also gives the instant (nextSendAt), so the screen can match the reader's clock; without it
 * the server's sentence stands.
 */
export function limitSentence(nextSendAt: string | undefined, fallback: string): string {
  const at = nextSendAt ? new Date(nextSendAt) : null;
  if (!at || Number.isNaN(at.getTime())) return fallback;
  const clock = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `You can send another message at ${clock}.`;
}

export interface PanelView {
  /** False: the panel is not there at all (not an organiser, or nobody else took part). */
  show: boolean;
  /** Where things stand, always shown as text when there is something to say. */
  status: string | null;
  /** "Sent to {n} people on {date}" once a message has gone out. */
  sent: string | null;
  /** A send that went wrong, said plainly. */
  problem: string | null;
  /** The button's words, or null when nothing can be sent right now. */
  action: string | null;
}

const HIDDEN: PanelView = { show: false, status: null, sent: null, problem: null, action: null };

/** What went wrong with the latest send, if anything: nobody reached, or some people missed. */
function problemOf(job: PostEventMessageJob | null | undefined): string | null {
  if (!job) return null;
  if (job.status === 'failed' && job.sentCount === 0) return LAST_SEND_FAILED;
  const done = job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed';
  return done && job.failedCount > 0 ? `${people(job.failedCount)} could not be reached.` : null;
}

/**
 * The panel for one organiser. Nobody who does not run the event sees it (visible: false); nor does anyone when
 * nobody else took part, since there is no one to write to (the controller's ruling on S6's no_recipients).
 */
export function panelView(e: BroadcastEligibilityV2 | undefined, job: PostEventMessageJob | null | undefined): PanelView {
  if (!e || !e.visible || e.reason === 'no_recipients') return HIDDEN;
  const sent = e.lastSent ? sentSentence(e.lastSent.recipients, e.lastSent.at) : null;
  const action = e.lastSent ? SEND_ANOTHER : WRITE_MESSAGE;
  switch (e.reason) {
    case 'ok':
      return { show: true, status: null, sent, problem: problemOf(job), action };
    case 'sending':
      return { show: true, status: e.explanation || null, sent: null, problem: null, action: null };
    case 'limit':
      return { show: true, status: limitSentence(e.nextSendAt, e.explanation), sent, problem: problemOf(job), action: null };
    default:
      return { show: true, status: e.explanation || null, sent, problem: problemOf(job), action: e.enabled ? action : null };
  }
}

/** How many people a send reaches: everyone who took part, and the people who did not come when asked for. */
export function recipientsOf(audience: BroadcastAudience, includeNoShows: boolean): number {
  return audience.tookPart + (includeNoShows ? audience.registeredNoShow : 0);
}

/** "Send to 2 people". */
export function sendLabel(n: number): string {
  return `Send to ${people(n)}`;
}

/** The composer's form: the organiser's own words (only the space around them is taken off), and the no-shows choice. */
export const composerSchema = z.object({
  body: z.string().trim().min(1, WRITE_FIRST).max(POST_EVENT_MESSAGE_LIMITS.bodyMax, BODY_TOO_LONG),
  includeNoShows: z.boolean(),
});
export type ComposerValues = z.infer<typeof composerSchema>;

interface FailedSend {
  isAxiosError?: unknown;
  request?: unknown;
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

/** The first message of a validation failure's details ({ field: [messages] }). */
function firstDetail(details: unknown): unknown {
  if (!details || typeof details !== 'object') return undefined;
  for (const messages of Object.values(details)) {
    if (Array.isArray(messages) && messages.length > 0) return messages[0];
  }
  return undefined;
}

/**
 * Why a send was refused, in one sentence: the server's own words when they are ones a member can read (the limit,
 * another organiser sending, a message too long), else a plain "try again".
 */
export function sendErrorSentence(err: unknown): string {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as FailedSend;
  const response = failed.response;
  if (!response) return failed.isAxiosError === true || failed.request != null ? CONNECTION_LOST : NOT_SENT;
  const error = response.data?.error;
  switch (response.status) {
    case 400:
      // A 400 with details is a validation failure, whose generic message ("Validation failed") is never shown.
      if (error?.details != null) return memberSentence(firstDetail(error.details)) ?? NOT_SENT;
      return memberSentence(error?.message) ?? NOT_SENT;
    case 403:
    case 409:
    case 429:
      return memberSentence(error?.message) ?? NOT_SENT;
    default:
      return NOT_SENT;
  }
}
