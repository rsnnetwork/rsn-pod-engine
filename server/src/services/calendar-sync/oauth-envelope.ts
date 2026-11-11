// ─── The calendar connect's three short-lived envelopes, and PKCE (Shirley pilot S8, D7) ──────────────────────────────
//
// A connection passes through three hands, and each hand gets an envelope sealed (AES-256-GCM, so it is both secret and
// tamper-evident) under a key derived from CALENDAR_TOKEN_KEY, with an expiry inside and its PURPOSE as the additional
// data, so one kind can never be passed off as another:
//   start   POST /api/calendar/connect/:provider -> the browser -> GET /api/calendar/:provider/start   (10 minutes)
//           { userId, provider, origin, returnTo }
//   state   the start -> the provider -> GET /api/calendar/:provider/callback                         (10 minutes)
//           { userId, provider, origin, returnTo, verifier, nonceHash }. The PKCE verifier rides here, sealed, so the
//           server stores nothing between the start and the callback, and nobody who sees the URL can read it.
//           nonceHash binds it to the browser that started (the nonce cookie, oauth-browser-binding.ts).
//   ticket  the callback -> the app -> POST /api/calendar/connections/:provider/finish                  (10 minutes)
//           { userId, provider, code, verifier }. The code is only exchanged when the member SIGNED IN to the app
//           finishing it is the member who started: a start address minted by someone else and opened by a victim
//           never connects the victim's calendar to the other account.

import { createHash, randomBytes } from 'crypto';
import type { CalendarProvider } from '@rsn/shared';
import { deriveKey, open, seal, SecretBoxError } from './secret-box';
import { isCalendarProvider } from './settings';

export const ENVELOPE_LIFETIME_MS = 10 * 60 * 1000;

export type EnvelopePurpose = 'start' | 'state' | 'ticket';

export interface StartEnvelope { userId: string; provider: CalendarProvider; origin: string; returnTo: string }
export interface StateEnvelope extends StartEnvelope { verifier: string; nonceHash: string }
export interface TicketEnvelope { userId: string; provider: CalendarProvider; code: string; verifier: string }

interface Shapes { start: StartEnvelope; state: StateEnvelope; ticket: TicketEnvelope }

/** Why an envelope was refused: a class of reason for the logs, never anything it held. */
export type EnvelopeRefusal = 'malformed' | 'tampered' | 'expired' | 'wrong provider';

export type Opened<T> = { ok: true; value: T } | { ok: false; reason: EnvelopeRefusal };

const envelopeKey = (master: Buffer) => deriveKey(master, 'oauth-envelope');
const aad = (purpose: EnvelopePurpose) => `calendar-envelope:${purpose}`;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENVELOPE_CHARS = 4096;

export function sealEnvelope<P extends EnvelopePurpose>(
  master: Buffer, purpose: P, value: Shapes[P], now: number = Date.now(),
): string {
  const body = JSON.stringify({ ...value, exp: now + ENVELOPE_LIFETIME_MS });
  return seal(envelopeKey(master), body, aad(purpose)).toString('base64url');
}

const STRING_FIELDS: Record<EnvelopePurpose, readonly string[]> = {
  start: ['userId', 'provider', 'origin', 'returnTo'],
  state: ['userId', 'provider', 'origin', 'returnTo', 'verifier', 'nonceHash'],
  ticket: ['userId', 'provider', 'code', 'verifier'],
};

function readSealed(master: Buffer, purpose: EnvelopePurpose, raw: unknown): Record<string, unknown> | EnvelopeRefusal {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENVELOPE_CHARS || !BASE64URL.test(raw)) {
    return 'malformed';
  }
  try {
    const parsed: unknown = JSON.parse(open(envelopeKey(master), Buffer.from(raw, 'base64url'), aad(purpose)));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : 'malformed';
  } catch (err) {
    return err instanceof SecretBoxError ? 'tampered' : 'malformed';
  }
}

/**
 * What an envelope of this purpose holds, when it was sealed by us, for this purpose, has not expired, and names
 * `provider`. Anything else is refused with a class of reason.
 */
export function openEnvelope<P extends EnvelopePurpose>(
  master: Buffer, purpose: P, raw: unknown, provider: CalendarProvider, now: number = Date.now(),
): Opened<Shapes[P]> {
  const parsed = readSealed(master, purpose, raw);
  if (typeof parsed === 'string') return { ok: false, reason: parsed };
  const fields = STRING_FIELDS[purpose];
  if (fields.some((f) => typeof parsed[f] !== 'string') || typeof parsed.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (!isCalendarProvider(parsed.provider)) return { ok: false, reason: 'malformed' };
  if (parsed.exp <= now) return { ok: false, reason: 'expired' };
  if (parsed.provider !== provider) return { ok: false, reason: 'wrong provider' };
  const value = Object.fromEntries(fields.map((f) => [f, parsed[f]]));
  return { ok: true, value: value as unknown as Shapes[P] };
}

/** One PKCE pair (RFC 7636, S256): the verifier stays with us (sealed in the state), the challenge goes to the provider. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url'); // 43 characters of the unreserved set
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A fingerprint of a ticket, to spend it once (never the ticket itself). */
export const ticketFingerprint = (raw: string) => createHash('sha256').update(raw).digest('hex');
