// ─── Google and Microsoft, as calendar free/busy providers (Shirley pilot S8, D7) ───────────────────────────────────────
//
// Each provider is four calls: the consent address, the code exchange (with PKCE), the refresh, and the busy read of
// the PRIMARY calendar for a range. Google also takes a revoke; Microsoft has no per-app revoke a third party can call.
//
// What is asked for, and why it is the least that works (checked against the providers' documentation, 11 Nov 2026):
//   Google     openid email https://www.googleapis.com/auth/calendar.freebusy
//              freeBusy.query on `primary` answers busy stretches only: no title, attendee, place or note can come back.
//   Microsoft  openid email offline_access https://graph.microsoft.com/Calendars.ReadBasic
//              getSchedule (true free/busy) is not offered to personal Microsoft accounts, so the default calendar's
//              calendarView is read with $select=start,end,showAs,isCancelled,isAllDay and nothing else. ReadBasic could
//              read an event's subject if asked; this code never asks, and nothing it reads is stored or logged.
//
// Errors come back as CalendarProviderError with a kind, never the provider's body (which can carry an address).

import type { CalendarProvider } from '@rsn/shared';
import { allDaySpan, type Span } from './intervals';
import type { ProviderCredentials } from './settings';

export type ProviderErrorKind =
  /** The grant is gone (consent removed, refresh token expired or revoked, password reset): connect again. */
  | 'invalid_grant'
  /** The access token was refused: refresh it once and try again. */
  | 'unauthorized'
  /** The account no longer lets REASON read the calendar (permission removed): connect again. */
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  /**
   * OUR side is set up wrong, not the member's grant: the Calendar API not enabled or the project suspended (Google's
   * 403 accessNotConfigured / SERVICE_DISABLED), a client id or secret refused (invalid_client, unauthorized_client).
   * Never a reconnect: connecting again could not fix it. Read as "unavailable" and logged loudly (S8 review I3).
   */
  | 'misconfigured'
  /** Something the provider should never send. */
  | 'bad_response';

export class CalendarProviderError extends Error {
  /** `reason`: for `misconfigured`, the provider's own short code that showed it (for the log), never its message. */
  constructor(public readonly kind: ProviderErrorKind, public readonly status?: number, public readonly reason?: string) {
    super(`Calendar provider error: ${kind}`);
    this.name = 'CalendarProviderError';
  }
}

/** The kinds that mean the member must connect again; the others are passing. */
export const NEEDS_RECONNECT: ReadonlySet<ProviderErrorKind> = new Set(['invalid_grant', 'forbidden']);

export interface GrantedTokens {
  accessToken: string;
  /** Seconds the access token lives. */
  expiresIn: number;
  refreshToken: string | null;
  scopes: string[];
  accountEmail: string | null;
}

export interface RefreshedTokens { accessToken: string; expiresIn: number; refreshToken: string | null }

export interface BusyRange { from: number; to: number; zone: string }

export interface CalendarProviderAdapter {
  readonly provider: CalendarProvider;
  /** The scope without which the connection is useless (a person may untick it on the consent screen). */
  hasCalendarScope(scopes: readonly string[]): boolean;
  authorizeUrl(a: { creds: ProviderCredentials; redirectUri: string; state: string; challenge: string }): string;
  exchangeCode(a: { creds: ProviderCredentials; redirectUri: string; code: string; verifier: string }): Promise<GrantedTokens>;
  /** `signal` is the caller's overall deadline for the busy read (each call also has its own 8-second limit). */
  refresh(a: { creds: ProviderCredentials; refreshToken: string; signal?: AbortSignal }): Promise<RefreshedTokens>;
  busy(accessToken: string, range: BusyRange, signal?: AbortSignal): Promise<Span[]>;
  /** True when the provider confirmed it forgot the grant; false when it has no such call or did not confirm. */
  revoke(a: { creds: ProviderCredentials; token: string }): Promise<boolean>;
}

const TIMEOUT_MS = 8000;
const MAX_PAGES = 10;

/** This call's own 8-second limit, and the caller's deadline when there is one: whichever comes first aborts it. */
function limitOf(deadline?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(TIMEOUT_MS);
  if (!deadline) return own;
  const both = new AbortController();
  const stop = () => both.abort();
  if (deadline.aborted) stop();
  deadline.addEventListener('abort', stop, { once: true });
  own.addEventListener('abort', stop, { once: true });
  return both.signal;
}

async function send(url: string, init: RequestInit, deadline?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: limitOf(deadline) });
  } catch {
    throw new CalendarProviderError('unavailable');
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A token endpoint's refusal, as a kind. */
function tokenErrorKind(status: number, body: Record<string, unknown>): ProviderErrorKind {
  const error = str(body.error);
  if (error === 'invalid_grant' || error === 'interaction_required' || error === 'consent_required') return 'invalid_grant';
  if (error === 'invalid_client' || error === 'unauthorized_client') return 'misconfigured';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'bad_response';
}

/** A token endpoint's refusal, as an error that carries the code when it is our own setup. */
function tokenError(status: number, body: Record<string, unknown>): CalendarProviderError {
  const kind = tokenErrorKind(status, body);
  return new CalendarProviderError(kind, status, kind === 'misconfigured' ? String(body.error) : undefined);
}

// Google's own words for "the REASON project cannot use the Calendar API" (the API is off, the project suspended or
// denied): only these, from Google only (S8 review N4), so a member's own refusal is never read as our setup.
const GOOGLE_PROJECT_REFUSED = /accessnotconfigured|service_disabled|has not been used in project|projectdenied/;
// A Microsoft tenant's administrator has blocked calendar access for the member's organisation: reconnecting would not
// help, and it is not our setup either, so it is passing (unavailable), quietly.
const MICROSOFT_TENANT_BLOCKED = /is disabled|blocked|suspended|mailboxnotenabled/;

/** A data API's refusal, as an error of a kind. */
function apiError(provider: 'google' | 'microsoft', status: number, body: Record<string, unknown>): CalendarProviderError {
  if (status === 401) return new CalendarProviderError('unauthorized', status);
  if (status === 429) return new CalendarProviderError('rate_limited', status);
  if (status >= 500) return new CalendarProviderError('unavailable', status);
  if (status === 403) {
    const text = JSON.stringify(body).toLowerCase();
    const refused = provider === 'google' ? GOOGLE_PROJECT_REFUSED.exec(text) : null;
    if (refused) return new CalendarProviderError('misconfigured', status, refused[0]);
    if (/ratelimit|quota|usagelimit|throttl/.test(text)) return new CalendarProviderError('rate_limited', status);
    if (provider === 'microsoft' && MICROSOFT_TENANT_BLOCKED.test(text)) return new CalendarProviderError('unavailable', status);
    return new CalendarProviderError('forbidden', status);
  }
  return new CalendarProviderError('bad_response', status);
}

/** The email in an ID token's claims. The token came straight from the provider over TLS, so it is read, not verified. */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const email = str(claims.email) ?? str(claims.preferred_username);
    return email && email.includes('@') ? email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

async function tokenCall(url: string, form: Record<string, string>, deadline?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  }, deadline);
  const body = await jsonOf(res);
  if (!res.ok) throw tokenError(res.status, body);
  if (!str(body.access_token)) throw new CalendarProviderError('bad_response', res.status);
  return body;
}

const expiresInOf = (body: Record<string, unknown>) => {
  const n = Number(body.expires_in);
  return Number.isFinite(n) && n > 0 ? n : 3600;
};

function granted(body: Record<string, unknown>): GrantedTokens {
  return {
    accessToken: String(body.access_token),
    expiresIn: expiresInOf(body),
    refreshToken: str(body.refresh_token),
    scopes: (str(body.scope) ?? '').split(/\s+/).filter(Boolean),
    accountEmail: emailFromIdToken(body.id_token),
  };
}

function refreshed(body: Record<string, unknown>): RefreshedTokens {
  return { accessToken: String(body.access_token), expiresIn: expiresInOf(body), refreshToken: str(body.refresh_token) };
}

// ─── Google ──────────────────────────────────────────────────────────────────

export const GOOGLE_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const GOOGLE_SCOPES = ['openid', 'email', GOOGLE_FREEBUSY_SCOPE].join(' ');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const google: CalendarProviderAdapter = {
  provider: 'google',
  hasCalendarScope: (scopes) => scopes.includes(GOOGLE_FREEBUSY_SCOPE),
  authorizeUrl: ({ creds, redirectUri, state, challenge }) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    // offline + consent: Google hands a refresh token only on a consent screen, and the busy read happens later.
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`,
  exchangeCode: async ({ creds, redirectUri, code, verifier }) => granted(await tokenCall(GOOGLE_TOKEN_URL, {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
    client_id: creds.clientId, client_secret: creds.clientSecret,
  })),
  refresh: async ({ creds, refreshToken, signal }) => refreshed(await tokenCall(GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret,
  }, signal)),
  busy: async (accessToken, range, signal) => {
    const res = await send('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        timeMin: new Date(range.from).toISOString(), timeMax: new Date(range.to).toISOString(), items: [{ id: 'primary' }],
      }),
    }, signal);
    const body = await jsonOf(res);
    if (!res.ok) throw apiError('google', res.status, body);
    const primary = (body.calendars as Record<string, { busy?: unknown; errors?: unknown }> | undefined)?.primary;
    if (!primary || (Array.isArray(primary.errors) && primary.errors.length > 0) || !Array.isArray(primary.busy)) {
      throw new CalendarProviderError('bad_response', res.status);
    }
    return (primary.busy as Array<{ start?: unknown; end?: unknown }>)
      .map((b) => ({ start: Date.parse(String(b.start)), end: Date.parse(String(b.end)) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
  },
  revoke: async ({ token }) => {
    const res = await send('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  },
};

// ─── Microsoft ───────────────────────────────────────────────────────────────

const MICROSOFT_CALENDAR_SCOPE = 'https://graph.microsoft.com/Calendars.ReadBasic';
const MICROSOFT_SCOPES = ['openid', 'email', 'offline_access', MICROSOFT_CALENDAR_SCOPE].join(' ');
const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
/** showAs values that mean the person cannot meet. "free" and "workingElsewhere" do not, nor does an unknown one. */
const MICROSOFT_BUSY = new Set(['busy', 'oof', 'tentative']);

/** Graph's "2026-11-12T09:00:00.0000000" in UTC (the Prefer header asks for UTC), as milliseconds. */
function graphInstant(value: unknown): number {
  const text = typeof value === 'string' ? value : '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/.exec(text);
  return match ? Date.parse(`${match[1]}Z`) : NaN;
}

interface GraphEvent {
  start?: { dateTime?: unknown };
  end?: { dateTime?: unknown };
  showAs?: unknown;
  isCancelled?: unknown;
  isAllDay?: unknown;
}

/** One Graph event as a busy span, or null when it does not make the person busy. */
export function graphEventSpan(event: GraphEvent, zone: string): Span | null {
  if (event.isCancelled === true) return null;
  if (typeof event.showAs !== 'string' || !MICROSOFT_BUSY.has(event.showAs)) return null;
  const start = graphInstant(event.start?.dateTime);
  const end = graphInstant(event.end?.dateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return event.isAllDay === true ? allDaySpan(start, end, zone) : { start, end };
}

const MICROSOFT_GRAPH = 'https://graph.microsoft.com/v1.0';

export const microsoft: CalendarProviderAdapter = {
  provider: 'microsoft',
  hasCalendarScope: (scopes) => scopes.some((s) => s.toLowerCase().endsWith('calendars.readbasic')),
  authorizeUrl: ({ creds, redirectUri, state, challenge }) => `${MICROSOFT_AUTHORITY}/authorize?${new URLSearchParams({
    client_id: creds.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: MICROSOFT_SCOPES,
    prompt: 'select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`,
  exchangeCode: async ({ creds, redirectUri, code, verifier }) => granted(await tokenCall(`${MICROSOFT_AUTHORITY}/token`, {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, scope: MICROSOFT_SCOPES,
    client_id: creds.clientId, client_secret: creds.clientSecret,
  })),
  // Microsoft hands a NEW refresh token on every refresh; the caller seals and keeps it.
  refresh: async ({ creds, refreshToken, signal }) => refreshed(await tokenCall(`${MICROSOFT_AUTHORITY}/token`, {
    grant_type: 'refresh_token', refresh_token: refreshToken, scope: MICROSOFT_SCOPES,
    client_id: creds.clientId, client_secret: creds.clientSecret,
  }, signal)),
  busy: async (accessToken, range, signal) => {
    const spans: Span[] = [];
    let url: string | null = `${MICROSOFT_GRAPH}/me/calendar/calendarView?${new URLSearchParams({
      startDateTime: new Date(range.from).toISOString(),
      endDateTime: new Date(range.to).toISOString(),
      $select: 'start,end,showAs,isCancelled,isAllDay',
      $top: '200',
    })}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      // Only ever a Graph address: a nextLink pointing anywhere else is not followed (the token would go with it).
      if (!url.startsWith(`${MICROSOFT_GRAPH}/`)) throw new CalendarProviderError('bad_response');
      const res = await send(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', Prefer: 'outlook.timezone="UTC"' },
      }, signal);
      const body = await jsonOf(res);
      if (!res.ok) throw apiError('microsoft', res.status, body);
      if (!Array.isArray(body.value)) throw new CalendarProviderError('bad_response', res.status);
      for (const event of body.value as GraphEvent[]) {
        const span = graphEventSpan(event, range.zone);
        if (span) spans.push(span);
      }
      url = str(body['@odata.nextLink']);
    }
    return spans;
  },
  // Microsoft offers no call for an app to drop one member's consent to it. The member removes REASON themselves
  // (account.live.com/consent/Manage for a personal account, myapps.microsoft.com for a work one): the client says so.
  revoke: async () => false,
};

export const PROVIDERS: Record<CalendarProvider, CalendarProviderAdapter> = { google, microsoft };
