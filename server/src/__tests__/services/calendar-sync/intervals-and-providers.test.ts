// ─── Calendar free/busy: busy intervals and the two providers, with fetch mocked (Shirley pilot S8, D7) ─────────────

import { allDaySpan, mergeSpans, toIntervals, zonedMidnight } from '../../../services/calendar-sync/intervals';
import {
  CalendarProviderError, emailFromIdToken, google, GOOGLE_FREEBUSY_SCOPE, graphEventSpan, microsoft, NEEDS_RECONNECT,
} from '../../../services/calendar-sync/providers';

const T = (iso: string) => Date.parse(iso);
const CREDS = { clientId: 'cid', clientSecret: 'csecret' };

interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown }> = [];
const realFetch = global.fetch;

beforeEach(() => {
  calls = [];
  answers = [];
  global.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});
afterAll(() => { global.fetch = realFetch; });

const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('busy intervals', () => {
  it('merges overlapping and touching stretches, clips to the range, drops empty ones', () => {
    const merged = mergeSpans([
      { start: T('2026-11-12T10:00:00Z'), end: T('2026-11-12T11:00:00Z') },
      { start: T('2026-11-12T08:00:00Z'), end: T('2026-11-12T09:00:00Z') },
      { start: T('2026-11-12T10:30:00Z'), end: T('2026-11-12T12:00:00Z') },
      { start: T('2026-11-12T12:00:00Z'), end: T('2026-11-12T12:30:00Z') },
      { start: T('2026-11-12T13:00:00Z'), end: T('2026-11-12T13:00:00Z') },
      { start: T('2026-11-11T20:00:00Z'), end: T('2026-11-12T07:30:00Z') },
    ], T('2026-11-12T07:00:00Z'), T('2026-11-13T00:00:00Z'));
    expect(toIntervals(merged)).toEqual([
      { start: '2026-11-12T07:00:00.000Z', end: '2026-11-12T07:30:00.000Z' },
      { start: '2026-11-12T08:00:00.000Z', end: '2026-11-12T09:00:00.000Z' },
      { start: '2026-11-12T10:00:00.000Z', end: '2026-11-12T12:30:00.000Z' },
    ]);
  });

  it('finds a day\'s midnight in a zone, across a daylight-saving change', () => {
    expect(new Date(zonedMidnight('2026-11-12', 'Europe/London')).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(new Date(zonedMidnight('2026-07-12', 'Europe/London')).toISOString()).toBe('2026-07-11T23:00:00.000Z');
    expect(new Date(zonedMidnight('2026-11-12', 'Asia/Karachi')).toISOString()).toBe('2026-11-11T19:00:00.000Z');
    expect(new Date(zonedMidnight('2026-11-12', 'America/New_York')).toISOString()).toBe('2026-11-12T05:00:00.000Z');
    // 29 March 2026: London's clocks go forward at 01:00.
    expect(new Date(zonedMidnight('2026-03-29', 'Europe/London')).toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(new Date(zonedMidnight('2026-03-30', 'Europe/London')).toISOString()).toBe('2026-03-29T23:00:00.000Z');
  });

  it('reads an all-day event as whole days on the viewer\'s clock, whichever way the provider wrote it', () => {
    const want = { start: zonedMidnight('2026-11-12', 'Asia/Karachi'), end: zonedMidnight('2026-11-14', 'Asia/Karachi') };
    // Floating midnight to midnight, two days.
    expect(allDaySpan(T('2026-11-12T00:00:00Z'), T('2026-11-14T00:00:00Z'), 'Asia/Karachi')).toEqual(want);
    // Converted to UTC from Berlin (the evening before).
    expect(allDaySpan(T('2026-11-11T23:00:00Z'), T('2026-11-13T23:00:00Z'), 'Asia/Karachi')).toEqual(want);
    // Converted to UTC from New York.
    expect(allDaySpan(T('2026-11-12T05:00:00Z'), T('2026-11-14T05:00:00Z'), 'Asia/Karachi')).toEqual(want);
    expect(allDaySpan(T('2026-11-12T00:00:00Z'), T('2026-11-12T00:00:00Z'), 'UTC')).toBeNull();
  });
});

describe('Google', () => {
  it('asks for openid, email and calendar.freebusy only, offline, with PKCE (S256) and our state', () => {
    const url = new URL(google.authorizeUrl({ creds: CREDS, redirectUri: 'https://api.x/api/calendar/google/callback', state: 'STATE', challenge: 'CHAL' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(`openid email ${GOOGLE_FREEBUSY_SCOPE}`);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });

  it('exchanges the code with the verifier, and reads the granted scopes and the account address', async () => {
    answers.push({ status: 200, body: {
      access_token: 'at', expires_in: 3599, refresh_token: 'rt', scope: `openid ${GOOGLE_FREEBUSY_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
      id_token: idToken({ email: 'shirley@example.com' }),
    } });
    const g = await google.exchangeCode({ creds: CREDS, redirectUri: 'https://r', code: 'CODE', verifier: 'VERIFIER' });
    expect(g).toEqual({ accessToken: 'at', expiresIn: 3599, refreshToken: 'rt', scopes: expect.arrayContaining([GOOGLE_FREEBUSY_SCOPE]), accountEmail: 'shirley@example.com' });
    expect(google.hasCalendarScope(g.scopes)).toBe(true);
    expect(google.hasCalendarScope(['openid', 'email'])).toBe(false);
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code', code: 'CODE', code_verifier: 'VERIFIER', redirect_uri: 'https://r', client_id: 'cid', client_secret: 'csecret',
    });
  });

  it('reads the primary calendar\'s busy stretches and nothing else', async () => {
    answers.push({ status: 200, body: { calendars: { primary: { busy: [{ start: '2026-11-12T09:00:00Z', end: '2026-11-12T10:00:00Z' }] } } } });
    const spans = await google.busy('AT', { from: T('2026-11-12T00:00:00Z'), to: T('2026-11-13T00:00:00Z'), zone: 'UTC' });
    expect(spans).toEqual([{ start: T('2026-11-12T09:00:00Z'), end: T('2026-11-12T10:00:00Z') }]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ timeMin: '2026-11-12T00:00:00.000Z', timeMax: '2026-11-13T00:00:00.000Z', items: [{ id: 'primary' }] });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  it('names each refusal by its kind, never by the provider\'s words', async () => {
    const kindOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CalendarProviderError ? e.kind : 'other'));
    answers.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    expect(await kindOf(google.refresh({ creds: CREDS, refreshToken: 'rt' }))).toBe('invalid_grant');
    answers.push({ status: 429, body: {} });
    expect(await kindOf(google.refresh({ creds: CREDS, refreshToken: 'rt' }))).toBe('rate_limited');
    answers.push({ status: 503, body: {} });
    expect(await kindOf(google.refresh({ creds: CREDS, refreshToken: 'rt' }))).toBe('unavailable');
    answers.push({ status: 401, body: {} });
    expect(await kindOf(google.busy('AT', { from: 0, to: 1, zone: 'UTC' }))).toBe('unauthorized');
    answers.push({ status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } });
    expect(await kindOf(google.busy('AT', { from: 0, to: 1, zone: 'UTC' }))).toBe('rate_limited');
    answers.push({ status: 403, body: { error: { errors: [{ reason: 'insufficientPermissions' }] } } });
    expect(await kindOf(google.busy('AT', { from: 0, to: 1, zone: 'UTC' }))).toBe('forbidden');
  });

  it('our own setup refused is "misconfigured", never a reconnect (S8 review I3)', async () => {
    const kindOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof CalendarProviderError ? e.kind : 'other'));
    for (const body of [
      { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }], message: 'Google Calendar API has not been used in project 1 before or it is disabled.' } },
      { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } },
    ]) {
      answers.push({ status: 403, body });
      expect(await kindOf(google.busy('AT', { from: 0, to: 1, zone: 'UTC' }))).toBe('misconfigured');
    }
    for (const error of ['invalid_client', 'unauthorized_client']) {
      answers.push({ status: 401, body: { error } });
      expect(await kindOf(microsoft.refresh({ creds: CREDS, refreshToken: 'rt' }))).toBe('misconfigured');
    }
    expect(NEEDS_RECONNECT.has('misconfigured')).toBe(false);
  });

  it('a call stops when the caller\'s overall deadline passes (S8 review M6)', async () => {
    let seen: AbortSignal | undefined;
    global.fetch = ((_url: string, init: RequestInit = {}) => {
      seen = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;
    const deadline = new AbortController();
    const reading = google.busy('AT', { from: 0, to: 1, zone: 'UTC' }, deadline.signal);
    deadline.abort();
    await expect(reading).rejects.toMatchObject({ kind: 'unavailable' });
    expect(seen?.aborted).toBe(true);
  });

  it('revokes the refresh token at Google', async () => {
    answers.push({ status: 200, body: {} });
    expect(await google.revoke({ creds: CREDS, token: 'rt' })).toBe(true);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(calls[0].init.body)).toBe('token=rt');
  });
});

describe('Microsoft', () => {
  it('asks the common endpoint for openid, email, offline_access and Calendars.ReadBasic, with PKCE', () => {
    const url = new URL(microsoft.authorizeUrl({ creds: CREDS, redirectUri: 'https://r', state: 'S', challenge: 'C' }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('openid email offline_access https://graph.microsoft.com/Calendars.ReadBasic');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(microsoft.hasCalendarScope(['https://graph.microsoft.com/Calendars.ReadBasic'])).toBe(true);
    expect(microsoft.hasCalendarScope(['Calendars.ReadBasic', 'User.Read'])).toBe(true);
    expect(microsoft.hasCalendarScope(['User.Read'])).toBe(false);
  });

  it('reads the default calendar\'s view asking only for times and show-as, following pages on Graph only', async () => {
    answers.push({ status: 200, body: {
      value: [
        { start: { dateTime: '2026-11-12T09:00:00.0000000' }, end: { dateTime: '2026-11-12T10:00:00.0000000' }, showAs: 'busy' },
        { start: { dateTime: '2026-11-12T11:00:00.0000000' }, end: { dateTime: '2026-11-12T12:00:00.0000000' }, showAs: 'free' },
        { start: { dateTime: '2026-11-12T13:00:00.0000000' }, end: { dateTime: '2026-11-12T14:00:00.0000000' }, showAs: 'busy', isCancelled: true },
        { start: { dateTime: '2026-11-12T15:00:00.0000000' }, end: { dateTime: '2026-11-12T16:00:00.0000000' }, showAs: 'workingElsewhere' },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?$skiptoken=abc',
    } });
    answers.push({ status: 200, body: { value: [
      { start: { dateTime: '2026-11-13T00:00:00.0000000' }, end: { dateTime: '2026-11-14T00:00:00.0000000' }, showAs: 'oof', isAllDay: true },
      { start: { dateTime: '2026-11-13T17:00:00.0000000' }, end: { dateTime: '2026-11-13T17:30:00.0000000' }, showAs: 'tentative' },
    ] } });
    const spans = await microsoft.busy('AT', { from: T('2026-11-12T00:00:00Z'), to: T('2026-11-19T00:00:00Z'), zone: 'Europe/London' });
    expect(spans).toEqual([
      { start: T('2026-11-12T09:00:00Z'), end: T('2026-11-12T10:00:00Z') },
      { start: T('2026-11-13T00:00:00Z'), end: T('2026-11-14T00:00:00Z') },
      { start: T('2026-11-13T17:00:00Z'), end: T('2026-11-13T17:30:00Z') },
    ]);
    const first = new URL(calls[0].url);
    expect(first.pathname).toBe('/v1.0/me/calendar/calendarView');
    expect(first.searchParams.get('$select')).toBe('start,end,showAs,isCancelled,isAllDay');
    expect(calls[0].url).not.toMatch(/subject|attendees|body|location/i);
    expect((calls[0].init.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"');
    expect(calls).toHaveLength(2);
  });

  it('never follows a next page that is not on Graph (the token would go with it)', async () => {
    answers.push({ status: 200, body: { value: [], '@odata.nextLink': 'https://evil.example/steal' } });
    await expect(microsoft.busy('AT', { from: 0, to: 1, zone: 'UTC' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the new refresh token Microsoft hands on a refresh', async () => {
    answers.push({ status: 200, body: { access_token: 'at2', expires_in: 3600, refresh_token: 'rt2' } });
    expect(await microsoft.refresh({ creds: CREDS, refreshToken: 'rt1' })).toEqual({ accessToken: 'at2', expiresIn: 3600, refreshToken: 'rt2' });
    expect(new URLSearchParams(String(calls[0].init.body)).get('grant_type')).toBe('refresh_token');
  });

  it('has no revoke call, and says so', async () => {
    expect(await microsoft.revoke({ creds: CREDS, token: 'x' })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reads an all-day event from Graph as whole days in the viewer\'s zone', () => {
    const span = graphEventSpan({ start: { dateTime: '2026-11-12T00:00:00.0000000' }, end: { dateTime: '2026-11-13T00:00:00.0000000' }, showAs: 'busy', isAllDay: true }, 'America/New_York');
    expect(span).toEqual({ start: T('2026-11-12T05:00:00Z'), end: T('2026-11-13T05:00:00Z') });
  });
});

describe('the account address from an ID token', () => {
  it('reads email, else preferred_username, and nothing that is not an address', () => {
    expect(emailFromIdToken(idToken({ email: 'a@b.c' }))).toBe('a@b.c');
    expect(emailFromIdToken(idToken({ preferred_username: 'x@y.z' }))).toBe('x@y.z');
    expect(emailFromIdToken(idToken({ preferred_username: 'not-an-address' }))).toBeNull();
    expect(emailFromIdToken('garbage')).toBeNull();
    expect(emailFromIdToken(undefined)).toBeNull();
  });
});
