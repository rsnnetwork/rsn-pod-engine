// ─── The RSN Call entry flow: its rules and its words (Part 2, Task 12; spec 02, 04, 12/01-05) ──────────────
//
// Open the link → give an email → type the 6-digit code from it → give only what this event still needs → in. This
// file decides which screen a person is on and says every sentence the flow shows; the components only draw. No imports
// but the shared package and the sign-in code's own words, so the server's test suite runs it.
//
// The email step never tells anyone whether an address may come in, or has an account: the server answers every
// well-formed address the same ({ sent: true }), so the page always moves on to "Check your inbox for a 6-digit code".
// Only once the code is proved does the event say whether it takes this address: an invitation-only event answers 403
// EVENT_ADMISSION_REQUIRED with details.admissionCode, the code stays valid, and the code step asks for the admission
// code and sends the same 6-digit code again with it.

import {
  EVENT_FORMATS,
  type CallEntryState, type CallLanding, type CallLandingGroupAsk, type EventFormat,
} from '@rsn/shared';
import { codeErrorMessage } from '../auth/sign-in-code';

// ─── The API the flow calls (and only these: every one is on the guest allowlist) ─────────

const enc = encodeURIComponent;

export const CALL_API = {
  landing: (code: string) => `/call-links/${enc(code)}`,
  email: (code: string) => `/call-links/${enc(code)}/email`,
  verify: (code: string) => `/call-links/${enc(code)}/verify`,
  entry: (code: string) => `/call-links/${enc(code)}/entry`,
  enter: (code: string) => `/call-links/${enc(code)}/enter`,
  myEvents: () => '/call-links/me/events',
  mySchedule: (sessionId: string) => `/sessions/${enc(sessionId)}/schedule/mine`,
} as const;

// ─── The four stages the progress dots name ───────────────────────────────────

export const PROGRESS_STEPS = ['Open link', 'Identify', 'Check', 'Join call'] as const;

/** Every screen the call page can show. */
export type CallScreen =
  | 'summary' | 'email' | 'code'
  | 'details' | 'joining' | 'live' | 'waiting' | 'pending'
  | 'declined' | 'refused' | 'ended' | 'cancelled';

/** Which of the four dots a screen is on (0-based). */
export function progressIndexOf(screen: CallScreen): number {
  switch (screen) {
    case 'summary':
      return 0;
    case 'email':
    case 'code':
      return 1;
    case 'details':
    case 'joining':
      return 2;
    default:
      return 3;
  }
}

/** Where a signed-out visitor is in identifying themselves. */
export type IdentifyPhase = 'summary' | 'email' | 'code';

export interface ScreenInput {
  landing: CallLanding;
  /** The signed-in person's state on the link; null while signed out. */
  entry: CallEntryState | null;
  /** Signed out: how far they have got. */
  phase: IdentifyPhase;
  /** They asked to join here (pressed Join, or identified themselves on this page): no second press is asked for. */
  started: boolean;
}

/** True when the event still needs something from the person before a place. */
export function somethingMissing(missing: CallEntryState['missing']): boolean {
  return missing.displayName || missing.group || missing.admissionCode;
}

/** The screen for what the server says, and how far the person has got on this page. */
export function callScreenOf({ landing, entry, phase, started }: ScreenInput): CallScreen {
  if (!entry) {
    if (landing.lifecycle === 'cancelled') return 'cancelled';
    if (landing.lifecycle === 'completed' || landing.lifecycle === 'archived') return 'ended';
    return phase;
  }
  switch (entry.step) {
    case 'enter':
      return 'live';
    case 'wait_for_start':
      return 'waiting';
    case 'pending_approval':
      return 'pending';
    case 'declined':
      return 'declined';
    case 'refused':
      return 'refused';
    case 'ended':
      return 'ended';
    case 'cancelled':
      return 'cancelled';
    case 'identify':
      return phase;
    default:
      // 'details' or 'request': first the event, with a button; once they asked, only what is missing, or straight in.
      if (!started) return 'summary';
      return somethingMissing(entry.missing) ? 'details' : 'joining';
  }
}

// ─── The details step: only what is missing ───────────────────────────────────

export interface DetailsFields {
  displayName: boolean;
  group: CallLandingGroupAsk | null;
  admissionCode: boolean;
}

/** The fields the details step shows: exactly those the server flagged in `missing` (a group only with its question). */
export function detailsFieldsFor(missing: CallEntryState['missing'], groupAsk: CallLandingGroupAsk | null): DetailsFields {
  return {
    displayName: missing.displayName,
    group: missing.group && groupAsk && groupAsk.options.length > 0 ? groupAsk : null,
    admissionCode: missing.admissionCode,
  };
}

// ─── The event, as the summary says it ────────────────────────────────────────

/** "This event will ask for: your email, your name, your group, an admission code" (signed out), or what is left. */
export function asksSentence(asks: CallLanding['asks'], signedIn: boolean): string | null {
  const parts = [
    ...(signedIn ? [] : ['your email']),
    ...(asks.displayName ? ['your name'] : []),
    ...(asks.group ? ['your group'] : []),
    ...(asks.admissionCode ? ['an admission code'] : []),
  ];
  return parts.length > 0 ? `This event will ask for: ${parts.join(', ')}` : null;
}

export function formatLabelOf(format: EventFormat): string {
  return EVENT_FORMATS[format]?.label ?? 'Event';
}

/** "1 hour", "45 minutes", "1 hour 30 minutes". */
export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const hours = h > 0 ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '';
  const mins = m > 0 ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : '';
  return [hours, mins].filter(Boolean).join(' ');
}

/** The event's time in the viewer's own zone: "Thursday 12 November, 18:00 CET". */
export function eventTimeLabel(iso: string | null, timeZone?: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  const zone = at.toLocaleTimeString('en-US', { timeZoneName: 'short', timeZone }).split(' ').pop() ?? '';
  return `${day}, ${time}${zone ? ` ${zone}` : ''}`;
}

/** "on Thursday 12 November at 18:00" for the waiting step, or "as soon as the organiser opens it". */
export function startsPhrase(iso: string | null, now: number = Date.now(), timeZone?: string): string {
  if (!iso) return 'as soon as the organiser opens it';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now) return 'as soon as the organiser opens it';
  const day = at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  return `on ${day} at ${time}`;
}

// ─── Every sentence the flow says ─────────────────────────────────────────────

export const CALL_WORDS = {
  checkInbox: 'Check your inbox for a 6-digit code',
  sendCode: 'Send me a code',
  admissionCodeLabel: 'Admission code (if you have one)',
  ended: 'This event has ended.',
  cancelled: 'This event was cancelled.',
  pending: 'Waiting for the organiser to approve you',
  pendingMore: 'This page updates by itself as soon as they decide.',
  declined: 'The organiser did not approve your request for this event.',
  notFound: "We couldn't find that event.",
  notFoundMore: 'Check the link you were sent, or ask the organiser for a new one.',
  loadFailed: "We couldn't open this event just now. Check your connection and try again.",
  joining: 'Taking you in…',
  joinFailed: "We couldn't take you in just now. Please try again.",
  linkExpired: 'That link from the email no longer works. Enter your email to get a new code.',
  becomeMember: 'Become a REASON member: meet people beyond this event.',
} as const;

/** "You're in. {title} starts {when}." */
export function youreInSentence(title: string, startsAt: string | null, now: number = Date.now()): string {
  return `You're in. ${title} starts ${startsPhrase(startsAt, now)}.`;
}

// ─── What a failed request says, and where ────────────────────────────────────

interface ApiFailure {
  response?: { status?: number; data?: { error?: { code?: string; message?: unknown; details?: unknown } } };
  request?: unknown;
  code?: unknown;
}

/** Where a failure belongs: beside a field, or over the whole form; `closed` when the event itself is over or gone. */
export interface EntryFailure {
  field: 'email' | 'code' | 'displayName' | 'admissionCode' | null;
  message: string;
  closed?: 'ended' | 'cancelled' | 'not_found';
}

const LONGEST = 200;
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** The server's sentence when it is short and free of ids, else null. */
function serverSentence(err: unknown): string | null {
  const message = (err as ApiFailure | null)?.response?.data?.error?.message;
  if (typeof message !== 'string') return null;
  const text = message.trim();
  return text && text.length <= LONGEST && !ID_LIKE.test(text) ? text : null;
}

function failureCode(err: unknown): string | undefined {
  return (err as ApiFailure | null)?.response?.data?.error?.code;
}

function noAnswer(err: unknown): boolean {
  const failed = (err ?? {}) as ApiFailure;
  return !failed.response && (failed.request != null || failed.code === 'ERR_NETWORK' || failed.code === 'ECONNABORTED');
}

const CONNECTION_LOST = 'Connection lost. Check your internet and try again.';
const SLOW_DOWN = 'Too many tries. Please wait a few minutes, then try again.';

/** A failure that says the event itself is over or gone, on any step. */
function closedFailure(err: unknown): EntryFailure | null {
  const code = failureCode(err);
  if (code === 'EVENT_ENDED') return { field: null, message: CALL_WORDS.ended, closed: 'ended' };
  if (code === 'EVENT_CANCELLED') return { field: null, message: CALL_WORDS.cancelled, closed: 'cancelled' };
  if (code === 'SESSION_NOT_FOUND') return { field: null, message: CALL_WORDS.notFound, closed: 'not_found' };
  return null;
}

/** Asking for the code (POST /email). */
export function emailFailure(err: unknown): EntryFailure {
  const closed = closedFailure(err);
  if (closed) return closed;
  if (noAnswer(err)) return { field: null, message: CONNECTION_LOST };
  const status = (err as ApiFailure | null)?.response?.status;
  const code = failureCode(err);
  if (status === 429) return { field: null, message: SLOW_DOWN };
  if (code === 'VALIDATION_ERROR') return { field: 'email', message: 'Enter a valid email address.' };
  if (status === 503) return { field: null, message: serverSentence(err) ?? 'We could not send the code. Please try again.' };
  return { field: null, message: 'We could not send the code. Please try again.' };
}

/** Checking the code, or the email's button (POST /verify). */
export function verifyFailure(err: unknown): EntryFailure {
  const closed = closedFailure(err);
  if (closed) return closed;
  if (noAnswer(err)) return { field: 'code', message: CONNECTION_LOST };
  if ((err as ApiFailure | null)?.response?.status === 429) {
    return { field: 'code', message: 'Too many codes tried. Please wait 15 minutes, then try again.' };
  }
  return { field: 'code', message: codeErrorMessage(err) };
}

/** The event's refusal of a proved address, after a right code: its own sentence, and whether an admission code helps. */
export interface AdmissionRefusal { message: string; askCode: boolean }

const INVITATION_ONLY = 'This event is invitation only. Enter your admission code, or ask the organiser to invite this email address.';

/** A 403 from /verify after a right code (EVENT_ADMISSION_REQUIRED or EVENT_PRIVATE), or null for any other answer. */
export function admissionRefusalOf(err: unknown): AdmissionRefusal | null {
  const failed = (err as ApiFailure | null)?.response;
  const code = failed?.data?.error?.code;
  if (failed?.status !== 403 || (code !== 'EVENT_ADMISSION_REQUIRED' && code !== 'EVENT_PRIVATE')) return null;
  const details = failed.data?.error?.details as { admissionCode?: unknown } | undefined;
  const askCode = typeof details?.admissionCode === 'boolean' ? details.admissionCode : code === 'EVENT_ADMISSION_REQUIRED';
  const fallback = askCode ? INVITATION_ONLY : 'This event is for its members and the people its organiser invites.';
  return { message: serverSentence(err) ?? fallback, askCode };
}

/**
 * The admission code's own refusal from /verify (409 ADMISSION_CODE_USED "This admission code has already been used.",
 * an expired or unknown code), in the server's words; null for anything else. Only an ADMISSION_CODE_* answer counts:
 * a 429 or a wrong 6-digit code says nothing about the admission code, and the email is not proved by it.
 */
export function admissionCodeFailure(err: unknown): string | null {
  const code = failureCode(err);
  if (!code || !code.startsWith('ADMISSION_CODE_')) return null;
  return serverSentence(err) ?? 'That admission code is not right.';
}

/** Said when an admission code sent with the proved address still did not let it in. */
export const ADMISSION_CODE_DID_NOT_WORK = "That admission code didn't let you in. Check it, or ask the organiser.";

/** The email's button failed: a closed account says so; anything else asks for the email again. */
export function tokenFailureMessage(err: unknown): string {
  const code = failureCode(err);
  if (code === 'ACCOUNT_CLOSED' || code === 'USER_SUSPENDED') return codeErrorMessage(err);
  if (noAnswer(err)) return CONNECTION_LOST;
  return CALL_WORDS.linkExpired;
}

/** Giving what is missing, and entering (POST /enter). */
export function enterFailure(err: unknown): EntryFailure {
  const closed = closedFailure(err);
  if (closed) return closed;
  if (noAnswer(err)) return { field: null, message: CONNECTION_LOST };
  const status = (err as ApiFailure | null)?.response?.status;
  const code = failureCode(err);
  if (status === 429) {
    return { field: 'admissionCode', message: 'Too many admission codes tried. Please wait a few minutes, then try again.' };
  }
  if (code && code.startsWith('ADMISSION_CODE_')) {
    return { field: 'admissionCode', message: serverSentence(err) ?? 'That admission code is not right.' };
  }
  if (code === 'VALIDATION_ERROR') return { field: 'displayName', message: 'Enter your name (up to 60 characters).' };
  if (status === 403 || status === 409) return { field: null, message: serverSentence(err) ?? CALL_WORDS.joinFailed };
  return { field: null, message: CALL_WORDS.joinFailed };
}

/** The refusal sentence the server wrote for this person, or a plain one. Never a code. */
export function refusalSentence(entry: CallEntryState): string {
  const text = entry.refusal?.message?.trim();
  return text && text.length <= LONGEST && !ID_LIKE.test(text) ? text : 'This event is not open to you.';
}

/** A landing read that failed: a link that leads nowhere, or one that could not be read now. */
export function landingFailure(err: unknown): 'not_found' | 'unavailable' {
  const status = (err as ApiFailure | null)?.response?.status;
  return status === 404 ? 'not_found' : 'unavailable';
}
