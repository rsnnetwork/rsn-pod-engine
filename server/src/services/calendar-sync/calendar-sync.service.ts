// ─── Calendar free/busy: connect, read, disconnect (Shirley pilot S8, 12 Nov 2026; brief RSN 10; plan decision D7) ────
//
// Optional and never in the way: nothing in booking (meeting-windows.service.ts, routes/meeting.ts) reads a calendar,
// and a provider that fails only adds an entry to `errors` in the busy answer, never an error status.
//
// WHOSE busy times are shown (ruling, S8): ONLY the caller's own, to the caller. The other person in a conversation
// never sees them, not even as anonymous "busy" blocks. Why this is the privacy-minimal rule:
//   - What the brief asks for is "so users do not offer times when they are already busy": a person's own calendar
//     is all that needs. The other side's willingness is already on screen as the times THEY offered.
//   - Anonymous blocks still disclose: anyone who can open a conversation with a member (a stranger after one accepted
//     request) would see that member's working pattern for a week, refreshed live, which the member never chose to
//     publish. The consent text promises the member that REASON uses busy times to shade THEIR OWN picker; showing
//     them to others would need a second, explicit consent and a block-aware audience rule.
//   - It keeps the server's answer simple to audit: /api/calendar/busy takes no other member's id at all.
//
// Connect (three steps, oauth-envelope.ts): POST connect gives a start address; the start sets the browser's nonce
// cookie and sends the browser to the provider with PKCE and a sealed state; the callback checks the state and the
// browser and sends the browser back to the app with a sealed ticket; the app, signed in, finishes, and only then is
// the code exchanged, and only for the member who started.

import { ErrorCodes, type CalendarBusy, type CalendarConnection, type CalendarDisconnectResult, type CalendarProvider } from '@rsn/shared';
import logger from '../../config/logger';
import { AppError, ValidationError } from '../../middleware/errors';
import { fanoutUserCalendars } from '../../realtime/fanout';
import { clientOriginConfig, resolveClientBaseUrl } from '../identity/client-origin';
import { browserBindingRefusal, newOauthNonce } from '../identity/oauth-browser-binding';
import { forgetBusy, readBusy, spendTicketOnce, writeBusy, busyField, BUSY_FRESH_MS } from './busy-cache';
import * as repo from './connections.repo';
import { fromIntervals, knownZone, mergeSpans, toIntervals, type Span } from './intervals';
import { newPkce, openEnvelope, sealEnvelope, ticketFingerprint } from './oauth-envelope';
import { CalendarProviderError, NEEDS_RECONNECT, PROVIDERS } from './providers';
import { open, seal, SecretBoxError, tokenAad } from './secret-box';
import {
  calendarCallbackUrl, calendarRedirectBase, calendarTokenKey, providerAvailable, providerCredentials, type ProviderCredentials,
} from './settings';

// ─── Errors a member can read ────────────────────────────────────────────────

const linkExpired = () => new AppError(400, ErrorCodes.CALENDAR_LINK_EXPIRED,
  'That calendar connection took too long or was already used. Please connect again.');
const wrongAccount = () => new AppError(403, ErrorCodes.CALENDAR_WRONG_ACCOUNT,
  'This calendar connection was started from another REASON account, so nothing was connected. Connect again from your own account.');
const scopeMissing = () => new AppError(400, ErrorCodes.CALENDAR_SCOPE_MISSING,
  'REASON needs permission to see when you are busy. Connect again and leave the calendar permission ticked.');
const providerFailed = () => new AppError(502, ErrorCodes.CALENDAR_PROVIDER_FAILED,
  'We could not connect your calendar just now. Please try again in a moment.');

/** The key and the provider's credentials, or a 404: the routes' gate makes this unreachable while the feature is off. */
function ready(provider: CalendarProvider): { key: Buffer; creds: ProviderCredentials } {
  const key = calendarTokenKey();
  const creds = providerCredentials(provider);
  if (!providerAvailable(provider) || !key || !creds) {
    throw new AppError(404, ErrorCodes.CALENDAR_PROVIDER_NOT_OFFERED, 'That calendar cannot be connected right now.');
  }
  return { key, creds };
}

// ─── Where the browser goes back to ──────────────────────────────────────────

export const DEFAULT_RETURN = '/settings';

// A return path is checked twice, and the second check is the one that matters. The first refuses anything that is not
// plainly a path on our site: not a string, too long, not starting with one "/", or holding a backslash, whitespace or a
// control character. URL parsers strip tab, CR and LF and read "\" as "/", so "/\t/evil.example" would otherwise become
// the protocol-relative "//evil.example" (S8 review C1). The second builds the URL against a fixed origin and keeps the
// result only when it is still that origin, returning just its path and query. outcomeUrl then checks the final URL's
// origin once more against the app's, so no return path can ever take the browser (or a ticket) to another site.
const PATH_ORIGIN = 'https://return-path.invalid';
const BACKSLASH = 92;
/** A backslash, whitespace (any Unicode space) or a control character: never in a return path. */
function hasUnsafePathChar(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === BACKSLASH || c === 0x1680 || (c >= 0x2000 && c <= 0x200f)
      || (c >= 0x2028 && c <= 0x202f) || c === 0x205f || c === 0x3000 || c === 0xfeff) return true;
  }
  return false;
}

/** A same-site path (and query) to come back to, or Settings. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return DEFAULT_RETURN;
  if (!raw.startsWith('/') || raw.startsWith('//') || hasUnsafePathChar(raw)) return DEFAULT_RETURN;
  let url: URL;
  try {
    url = new URL(raw, `${PATH_ORIGIN}/`);
  } catch {
    return DEFAULT_RETURN;
  }
  if (url.origin !== PATH_ORIGIN || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) return DEFAULT_RETURN;
  return `${url.pathname}${url.search}`;
}

export type ConnectOutcome = 'finish' | 'cancelled' | 'failed' | 'try_again' | 'admin';

/** The app address the browser lands on: the return path on one of our own sites, with the outcome in the query. */
export function outcomeUrl(clientBase: string, returnTo: string, outcome: ConnectOutcome, provider: CalendarProvider, ticket?: string): string {
  const appOrigin = new URL(clientBase).origin;
  let url = new URL(safeReturnPath(returnTo), `${appOrigin}/`);
  if (url.origin !== appOrigin) url = new URL(DEFAULT_RETURN, `${appOrigin}/`);
  url.searchParams.set('calendar', outcome);
  url.searchParams.set('calendarProvider', provider);
  if (ticket) url.searchParams.set('calendarTicket', ticket);
  return url.toString();
}

// ─── Connect ─────────────────────────────────────────────────────────────────

/** Step 1 (signed in): the start address for this member. `origin` is the asking page's site, checked again later. */
export function beginConnect(userId: string, provider: CalendarProvider, origin: string, returnTo: unknown): string {
  const { key } = ready(provider);
  const clientBase = resolveClientBaseUrl(origin, clientOriginConfig());
  const t = sealEnvelope(key, 'start', { userId, provider, origin: clientBase, returnTo: safeReturnPath(returnTo) });
  return `${calendarRedirectBase()}/api/calendar/${provider}/start?t=${encodeURIComponent(t)}`;
}

export type StartAnswer =
  | { kind: 'redirect'; location: string; nonce: string }
  | { kind: 'refused'; location: string };

/** Step 2 (the browser, on the API's host): where to send it, and the nonce its cookie must hold. */
export function startAuthorization(provider: CalendarProvider, rawStart: unknown): StartAnswer {
  const { key, creds } = ready(provider);
  const opened = openEnvelope(key, 'start', rawStart, provider);
  if (!opened.ok) {
    logger.warn({ provider, reason: opened.reason }, 'Calendar connect start refused');
    return { kind: 'refused', location: outcomeUrl(resolveClientBaseUrl(undefined, clientOriginConfig()), DEFAULT_RETURN, 'failed', provider) };
  }
  const { nonce, nonceHash } = newOauthNonce();
  const { verifier, challenge } = newPkce();
  const state = sealEnvelope(key, 'state', { ...opened.value, verifier, nonceHash });
  const location = PROVIDERS[provider].authorizeUrl({ creds, redirectUri: calendarCallbackUrl(provider), state, challenge });
  return { kind: 'redirect', location, nonce };
}

export interface CallbackQuery { code?: unknown; state?: unknown; error?: unknown; error_description?: unknown }

/** Why the provider sent no code, in the app's words. A work account whose tenant needs an admin's approval is told so. */
function noCodeOutcome(q: CallbackQuery): ConnectOutcome {
  const error = typeof q.error === 'string' ? q.error : '';
  const detail = typeof q.error_description === 'string' ? q.error_description : '';
  if (error === 'consent_required' || /AADSTS(90094|90095|65002|90099)/.test(detail)) return 'admin';
  return error === 'access_denied' ? 'cancelled' : 'failed';
}

/** Step 3 (the browser, back from the provider): where to send it next. */
export function callbackLocation(provider: CalendarProvider, q: CallbackQuery, cookieNonces: readonly string[]): string {
  const { key } = ready(provider);
  const opened = openEnvelope(key, 'state', q.state, provider);
  if (!opened.ok) {
    logger.warn({ provider, reason: opened.reason }, 'Calendar connect state refused');
    return outcomeUrl(resolveClientBaseUrl(undefined, clientOriginConfig()), DEFAULT_RETURN, 'failed', provider);
  }
  const s = opened.value;
  const clientBase = resolveClientBaseUrl(s.origin, clientOriginConfig());
  if (typeof q.code !== 'string' || q.code.length === 0 || q.code.length > 2048) {
    return outcomeUrl(clientBase, s.returnTo, noCodeOutcome(q), provider);
  }
  const refusal = browserBindingRefusal({ rawState: q.state as string, nonceHash: s.nonceHash, cookieNonces });
  if (refusal) {
    logger.warn({ provider, reason: refusal }, 'Calendar connect refused: it did not start in this browser');
    return outcomeUrl(clientBase, s.returnTo, 'try_again', provider);
  }
  const ticket = sealEnvelope(key, 'ticket', { userId: s.userId, provider, code: q.code, verifier: s.verifier });
  return outcomeUrl(clientBase, s.returnTo, 'finish', provider, ticket);
}

/** Step 4 (signed in): exchange the code, for the member who started, and keep the grant sealed. */
export async function finishConnect(userId: string, provider: CalendarProvider, rawTicket: unknown): Promise<CalendarConnection> {
  const { key, creds } = ready(provider);
  const opened = openEnvelope(key, 'ticket', rawTicket, provider);
  if (!opened.ok) {
    logger.warn({ provider, reason: opened.reason }, 'Calendar connect ticket refused');
    throw linkExpired();
  }
  const t = opened.value;
  if (t.userId !== userId) {
    logger.warn({ provider }, 'Calendar connect refused: finished by another member than the one who started');
    throw wrongAccount();
  }
  if (!(await spendTicketOnce(ticketFingerprint(rawTicket as string)))) throw linkExpired();

  const adapter = PROVIDERS[provider];
  let granted;
  try {
    granted = await adapter.exchangeCode({ creds, redirectUri: calendarCallbackUrl(provider), code: t.code, verifier: t.verifier });
  } catch (err) {
    const kind = err instanceof CalendarProviderError ? err.kind : 'unexpected';
    logger.warn({ provider, kind }, 'Calendar connect: the code exchange failed');
    throw kind === 'invalid_grant' ? linkExpired() : providerFailed();
  }
  if (!adapter.hasCalendarScope(granted.scopes)) {
    void adapter.revoke({ creds, token: granted.refreshToken ?? granted.accessToken }).catch(() => false);
    throw scopeMissing();
  }
  if (!granted.refreshToken) {
    logger.warn({ provider }, 'Calendar connect: the provider gave no refresh token');
    throw providerFailed();
  }
  // A connect again replaces the grant: the one it replaces is handed back to the provider afterwards (S8 review M1).
  const previous = await repo.sealedRow(userId, provider);
  const connection = await repo.upsertConnection(userId, provider, {
    accountEmail: granted.accountEmail,
    scopes: granted.scopes,
    refreshTokenEnc: seal(key, granted.refreshToken, tokenAad(userId, provider, 'refresh')),
    accessTokenEnc: seal(key, granted.accessToken, tokenAad(userId, provider, 'access')),
    accessExpiresAt: new Date(Date.now() + granted.expiresIn * 1000),
  });
  await forgetBusy(userId, [provider]);
  if (previous) void revokeReplaced(previous, granted.refreshToken);
  return connection;
}

/** The grant a reconnect replaced, revoked where the provider allows (never the new one). Never throws. */
async function revokeReplaced(previous: repo.ConnectionRow, newRefreshToken: string): Promise<void> {
  const key = calendarTokenKey();
  const creds = providerCredentials(previous.provider);
  if (!key || !creds) return;
  try {
    const old = open(key, previous.refresh_token_enc, tokenAad(previous.user_id, previous.provider, 'refresh'));
    if (old !== newRefreshToken) await PROVIDERS[previous.provider].revoke({ creds, token: old });
  } catch {
    // A grant the key cannot open, or a provider that does not answer: nothing more can be done for it.
  }
}

export const listConnections = (userId: string): Promise<CalendarConnection[]> => repo.listForMember(userId);

// ─── Disconnect ──────────────────────────────────────────────────────────────

/** Ask the provider to forget the grant, when it can be asked. Never throws. */
async function revokeAtProvider(row: repo.ConnectionRow): Promise<boolean> {
  const key = calendarTokenKey();
  const creds = providerCredentials(row.provider);
  if (!key || !creds) return false;
  try {
    const token = open(key, row.refresh_token_enc, tokenAad(row.user_id, row.provider, 'refresh'));
    return await PROVIDERS[row.provider].revoke({ creds, token });
  } catch (err) {
    logger.warn({ provider: row.provider, kind: err instanceof CalendarProviderError ? err.kind : 'unopened' }, 'Calendar revoke at the provider failed');
    return false;
  }
}

/** Disconnect: best effort at the provider, then the row (and its sealed tokens) and its cached busy times are gone. */
export async function disconnect(userId: string, provider: CalendarProvider): Promise<CalendarDisconnectResult> {
  const row = await repo.sealedRow(userId, provider);
  const revokedAtProvider = row ? await revokeAtProvider(row) : false;
  await repo.deleteConnection(userId, provider);
  await forgetBusy(userId, [provider]);
  return { disconnected: true, revokedAtProvider };
}

/**
 * Closing an account (identity.service deleteUser): every connection is revoked where it can be and deleted, because a
 * close only marks the account (ON DELETE CASCADE never fires). Never throws: a close never waits on a calendar.
 */
export async function forgetCalendarConnections(userId: string): Promise<void> {
  try {
    const rows = await repo.sealedRowsOf(userId);
    if (rows.length === 0) return;
    await Promise.all(rows.map(revokeAtProvider));
    await repo.deleteAllOf(userId);
    await forgetBusy(userId, rows.map((r) => r.provider));
    void fanoutUserCalendars(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'Calendar connections were not forgotten on account close');
  }
}

// ─── Busy times ──────────────────────────────────────────────────────────────

export const MAX_RANGE_MS = 31 * 86_400_000;
/** The whole busy read (refreshes and every page of every provider) answers within this, or goes on without it. */
export const BUSY_DEADLINE_MS = 10_000;
const HOUR_MS = 3_600_000;
const PAST_SLACK_MS = 2 * 86_400_000;
const FUTURE_LIMIT_MS = 62 * 86_400_000;
const EXPIRY_MARGIN_MS = 60_000;

export interface BusyRequest { from: string; to: string; zone?: string }

/** The range asked for, held to sense: a real span, at most 31 days, around now. */
export function busyRange(r: BusyRequest, now: number = Date.now()): { from: number; to: number; zone: string } {
  const from = Date.parse(r.from);
  const to = Date.parse(r.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new ValidationError('Choose a time range that ends after it starts.');
  if (to - from > MAX_RANGE_MS) throw new ValidationError('Choose a time range of 31 days or less.');
  if (from < now - PAST_SLACK_MS || to > now + FUTURE_LIMIT_MS) throw new ValidationError('Choose a time range around now.');
  const zone = r.zone && knownZone(r.zone) ? r.zone : 'UTC';
  // Whole hours, so the ranges a member can ask for (and the cache entries they make) stay few (S8 review I1).
  return { from: Math.floor(from / HOUR_MS) * HOUR_MS, to: Math.ceil(to / HOUR_MS) * HOUR_MS, zone };
}

const refreshing = new Map<string, Promise<string>>();

/** A fresh access token, refreshing (once at a time per connection in this process) when it has run out. */
async function accessTokenFor(row: repo.ConnectionRow, key: Buffer, creds: ProviderCredentials, force: boolean, deadline?: AbortSignal): Promise<string> {
  const valid = row.access_token_enc && row.access_expires_at
    && new Date(row.access_expires_at).getTime() - EXPIRY_MARGIN_MS > Date.now();
  if (valid && !force) return open(key, row.access_token_enc as Buffer, tokenAad(row.user_id, row.provider, 'access'));
  const inFlight = refreshing.get(row.id);
  if (inFlight) return inFlight;
  const run = (async () => {
    const refreshToken = open(key, row.refresh_token_enc, tokenAad(row.user_id, row.provider, 'refresh'));
    const r = await PROVIDERS[row.provider].refresh({ creds, refreshToken, signal: deadline });
    // Rotated on every refresh: Microsoft's new refresh token, or Google's same one sealed again under a fresh IV.
    await repo.saveRefresh(
      row.id,
      row.refresh_token_enc,
      seal(key, r.refreshToken ?? refreshToken, tokenAad(row.user_id, row.provider, 'refresh')),
      seal(key, r.accessToken, tokenAad(row.user_id, row.provider, 'access')),
      new Date(Date.now() + r.expiresIn * 1000),
    );
    return r.accessToken;
  })();
  refreshing.set(row.id, run);
  try {
    return await run;
  } finally {
    refreshing.delete(row.id);
  }
}

type ProviderRead = { ok: true; spans: Span[] } | { ok: false; code: 'unavailable' | 'reconnect' };

/** The member must connect this calendar again: marked, their screens told, its cache dropped. */
async function needsReconnect(row: repo.ConnectionRow, code: string): Promise<ProviderRead> {
  logger.info({ provider: row.provider, code }, 'Calendar connection needs reconnecting');
  if (await repo.markNeedsReconnect(row.id, code)) {
    await forgetBusy(row.user_id, [row.provider]);
    void fanoutUserCalendars(row.user_id);
  }
  return { ok: false, code: 'reconnect' };
}

/** Our own setup is wrong (the Calendar API off, a client refused): said at error level once per provider per process. */
const misconfiguredLogged = new Set<string>();
function logMisconfigured(provider: CalendarProvider): void {
  if (misconfiguredLogged.has(provider)) return;
  misconfiguredLogged.add(provider);
  logger.error({ provider }, 'Calendar provider refused REASON itself (API not enabled, project suspended or client refused): busy times are unavailable for everyone until the provider console is fixed; no member is asked to reconnect');
}

async function readProvider(row: repo.ConnectionRow, range: { from: number; to: number; zone: string }, deadline: AbortSignal): Promise<ProviderRead> {
  const key = calendarTokenKey();
  const creds = providerCredentials(row.provider);
  if (!key || !creds || !providerAvailable(row.provider)) return { ok: false, code: 'unavailable' };
  const field = busyField(new Date(row.connected_at), range.from, range.to, range.zone);
  const cached = await readBusy(row.user_id, row.provider, field);
  if (cached && Date.now() - cached.at <= BUSY_FRESH_MS) return { ok: true, spans: fromIntervals(cached.busy) };

  const adapter = PROVIDERS[row.provider];
  try {
    let spans: Span[];
    try {
      spans = await adapter.busy(await accessTokenFor(row, key, creds, false, deadline), range, deadline);
    } catch (err) {
      if (!(err instanceof CalendarProviderError) || err.kind !== 'unauthorized') throw err;
      spans = await adapter.busy(await accessTokenFor(row, key, creds, true, deadline), range, deadline);
    }
    const merged = mergeSpans(spans, range.from, range.to);
    await writeBusy(row.user_id, row.provider, field, toIntervals(merged));
    void repo.touchUsed(row.id).catch(() => undefined);
    return { ok: true, spans: merged };
  } catch (err) {
    if (err instanceof SecretBoxError) return needsReconnect(row, 'key');
    if (err instanceof CalendarProviderError && NEEDS_RECONNECT.has(err.kind)) return needsReconnect(row, err.kind);
    const kind = err instanceof CalendarProviderError ? err.kind : 'unexpected';
    if (kind === 'misconfigured') logMisconfigured(row.provider);
    else logger.warn({ provider: row.provider, kind, stale: !!cached }, 'Calendar busy read failed; the picker goes on without it');
    return cached ? { ok: true, spans: fromIntervals(cached.busy) } : { ok: false, code: 'unavailable' };
  }
}

/** The caller's own busy times in the range, merged across their calendars. Never throws for a provider's sake. */
export async function busyFor(userId: string, request: BusyRequest): Promise<CalendarBusy> {
  const range = busyRange(request);
  const rows = await repo.sealedRowsOf(userId);
  const deadline = AbortSignal.timeout(BUSY_DEADLINE_MS);
  const reads = await Promise.all(rows.map(async (row) => ({
    row,
    read: row.status === 'active' ? await readProvider(row, range, deadline) : { ok: false as const, code: 'reconnect' as const },
  })));
  const spans: Span[] = [];
  const errors: CalendarBusy['errors'] = [];
  for (const { row, read } of reads) {
    if (read.ok) spans.push(...read.spans);
    else errors.push({ provider: row.provider, code: read.code });
  }
  return {
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    connected: reads.map(({ row, read }) => ({
      provider: row.provider,
      status: !read.ok && read.code === 'reconnect' ? 'needs_reconnect' : 'active',
    })),
    busy: toIntervals(mergeSpans(spans, range.from, range.to)),
    errors,
  };
}
