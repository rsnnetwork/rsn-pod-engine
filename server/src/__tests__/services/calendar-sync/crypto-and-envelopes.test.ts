// ─── Calendar free/busy: token encryption, the OAuth envelopes, PKCE, the switch (Shirley pilot S8, D7) ───────────────

const mockConfig = {
  calendarSync: 'on' as 'on' | 'off',
  calendarTokenKey: '',
  calendarRedirectBase: '',
  apiBaseUrl: 'https://api.example.test',
  googleCalendarClientId: 'g-id', googleCalendarClientSecret: 'g-secret',
  microsoftCalendarClientId: 'm-id', microsoftCalendarClientSecret: 'm-secret',
};
jest.mock('../../../config', () => ({ __esModule: true, default: mockConfig }));
jest.mock('../../../config/logger', () => ({
  __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { randomBytes } from 'crypto';
import { deriveKey, open, seal, SecretBoxError, tokenAad } from '../../../services/calendar-sync/secret-box';
import {
  ENVELOPE_LIFETIME_MS, newPkce, openEnvelope, pkceChallenge, sealEnvelope,
} from '../../../services/calendar-sync/oauth-envelope';
import { calendarCallbackUrl, calendarSyncState, calendarTokenKey } from '../../../services/calendar-sync/settings';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const USER = 'a0000000-0000-4000-8000-0000000000a1';
const OTHER = 'b0000000-0000-4000-8000-0000000000b2';

describe('token encryption at rest (AES-256-GCM)', () => {
  it('opens what it sealed, with a fresh IV every time, and never holds the plaintext', () => {
    const aad = tokenAad(USER, 'google', 'refresh');
    const a = seal(KEY, '1//refresh-token-value', aad);
    const b = seal(KEY, '1//refresh-token-value', aad);
    expect(open(KEY, a, aad)).toBe('1//refresh-token-value');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('refresh-token-value');
  });

  it('refuses the wrong key, another member, another token kind, and one flipped bit', () => {
    const aad = tokenAad(USER, 'google', 'refresh');
    const sealed = seal(KEY, 'secret', aad);
    expect(() => open(OTHER_KEY, sealed, aad)).toThrow(SecretBoxError);
    expect(() => open(KEY, sealed, tokenAad(OTHER, 'google', 'refresh'))).toThrow(SecretBoxError);
    expect(() => open(KEY, sealed, tokenAad(USER, 'google', 'access'))).toThrow(SecretBoxError);
    expect(() => open(KEY, sealed, tokenAad(USER, 'microsoft', 'refresh'))).toThrow(SecretBoxError);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] ^= 1;
    expect(() => open(KEY, flipped, aad)).toThrow(SecretBoxError);
    expect(() => open(KEY, Buffer.alloc(10), aad)).toThrow(SecretBoxError);
  });

  it('derives a separate key per purpose, so nothing in a URL is sealed under the token key itself', () => {
    expect(deriveKey(KEY, 'oauth-envelope').equals(KEY)).toBe(false);
    expect(deriveKey(KEY, 'oauth-envelope').equals(deriveKey(KEY, 'oauth-envelope'))).toBe(true);
    expect(deriveKey(KEY, 'a').equals(deriveKey(KEY, 'b'))).toBe(false);
  });
});

describe('the OAuth envelopes (signed, expiring, bound to a purpose, a provider and a member)', () => {
  const state = { userId: USER, provider: 'google' as const, origin: 'https://app.rsn.network', returnTo: '/settings', verifier: 'v'.repeat(43), nonceHash: 'h'.repeat(64) };

  it('round-trips, and travels as base64url', () => {
    const raw = sealEnvelope(KEY, 'state', state);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(openEnvelope(KEY, 'state', raw, 'google')).toEqual({ ok: true, value: state });
    // The verifier is sealed, never readable in the URL.
    expect(Buffer.from(raw, 'base64url').toString('latin1')).not.toContain('vvvvvvvv');
  });

  it('refuses a tampered envelope, the wrong key, and one passed off as another purpose', () => {
    const raw = sealEnvelope(KEY, 'state', state);
    const bytes = Buffer.from(raw, 'base64url');
    bytes[20] ^= 1;
    expect(openEnvelope(KEY, 'state', bytes.toString('base64url'), 'google')).toEqual({ ok: false, reason: 'tampered' });
    expect(openEnvelope(OTHER_KEY, 'state', raw, 'google')).toEqual({ ok: false, reason: 'tampered' });
    expect(openEnvelope(KEY, 'ticket', raw, 'google')).toEqual({ ok: false, reason: 'tampered' });
    expect(openEnvelope(KEY, 'start', raw, 'google')).toEqual({ ok: false, reason: 'tampered' });
  });

  it('expires after ten minutes', () => {
    const now = Date.now();
    const raw = sealEnvelope(KEY, 'state', state, now);
    expect(openEnvelope(KEY, 'state', raw, 'google', now + ENVELOPE_LIFETIME_MS - 1).ok).toBe(true);
    expect(openEnvelope(KEY, 'state', raw, 'google', now + ENVELOPE_LIFETIME_MS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses another provider, and anything that is not an envelope at all', () => {
    const raw = sealEnvelope(KEY, 'state', state);
    expect(openEnvelope(KEY, 'state', raw, 'microsoft')).toEqual({ ok: false, reason: 'wrong provider' });
    for (const junk of [undefined, '', 'not base64!', 'a'.repeat(5000), ['x'], 42]) {
      expect(openEnvelope(KEY, 'state', junk, 'google')).toEqual({ ok: false, reason: expect.stringMatching(/malformed|tampered/) });
    }
  });

  it('carries the member it was made for (the finish compares it with whoever is signed in)', () => {
    const raw = sealEnvelope(KEY, 'ticket', { userId: USER, provider: 'microsoft', code: 'c', verifier: 'v' });
    const opened = openEnvelope(KEY, 'ticket', raw, 'microsoft');
    expect(opened.ok && opened.value.userId).toBe(USER);
  });
});

describe('PKCE (RFC 7636, S256)', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a fresh 43-character verifier and its challenge each time', () => {
    const a = newPkce();
    const b = newPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('the switch fails closed', () => {
  const goodKey = randomBytes(32).toString('base64');
  afterEach(() => {
    Object.assign(mockConfig, {
      calendarSync: 'on', calendarTokenKey: '', calendarRedirectBase: '',
      googleCalendarClientId: 'g-id', googleCalendarClientSecret: 'g-secret',
      microsoftCalendarClientId: 'm-id', microsoftCalendarClientSecret: 'm-secret',
    });
  });

  it('is off unless CALENDAR_SYNC is on', () => {
    Object.assign(mockConfig, { calendarSync: 'off', calendarTokenKey: goodKey });
    expect(calendarSyncState()).toEqual({ enabled: false, providers: [], offReason: 'switched_off' });
  });

  it('stays off with no key, or a key that is not exactly 32 bytes of base64', () => {
    for (const bad of ['', 'short', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'),
      randomBytes(32).toString('base64url'), `${goodKey}x`, `  ${'!'.repeat(43)}=`]) {
      mockConfig.calendarTokenKey = bad;
      expect(calendarTokenKey()).toBeNull();
      expect(calendarSyncState()).toEqual({ enabled: false, providers: [], offReason: 'no_key' });
    }
  });

  it('is on with the key, offering only the providers with both an id and a secret', () => {
    mockConfig.calendarTokenKey = goodKey;
    expect(calendarTokenKey()?.length).toBe(32);
    expect(calendarSyncState()).toEqual({ enabled: true, providers: ['google', 'microsoft'] });
    mockConfig.microsoftCalendarClientSecret = '';
    expect(calendarSyncState()).toEqual({ enabled: true, providers: ['google'] });
    mockConfig.googleCalendarClientId = '';
    expect(calendarSyncState()).toEqual({ enabled: false, providers: [], offReason: 'no_provider' });
  });

  it('sends the provider back to the API host, or to CALENDAR_REDIRECT_BASE when it is set', () => {
    expect(calendarCallbackUrl('google')).toBe('https://api.example.test/api/calendar/google/callback');
    mockConfig.calendarRedirectBase = 'https://api.rsn.network/';
    expect(calendarCallbackUrl('microsoft')).toBe('https://api.rsn.network/api/calendar/microsoft/callback');
  });
});
