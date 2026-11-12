// ─── Calendar free/busy: is it on, and with what (Shirley pilot S8, D7) ───────────────────────────────────────────────
//
// Read from `config` at the moment of each call (never cached), so a test or a restart with new settings is obeyed.
// The feature fails closed: CALENDAR_SYNC=on alone is not enough. It is on only when
//   - CALENDAR_SYNC is 'on',
//   - CALENDAR_TOKEN_KEY is exactly 32 bytes written in base64 (`openssl rand -base64 32`): tokens are never stored
//     without it, and a key that is wrong would lock every stored token away,
//   - and at least one provider has both its client id and its client secret.
// A provider without both is simply not offered.

import config from '../../config';
import logger from '../../config/logger';
import type { CalendarProvider } from '@rsn/shared';

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ['google', 'microsoft'];

export const isCalendarProvider = (value: unknown): value is CalendarProvider =>
  typeof value === 'string' && (CALENDAR_PROVIDERS as readonly string[]).includes(value);

const STRICT_BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

/** The 32-byte token key, or null when CALENDAR_TOKEN_KEY is missing or is not exactly 32 bytes in base64. */
export function calendarTokenKey(): Buffer | null {
  const raw = (config.calendarTokenKey || '').trim();
  if (!STRICT_BASE64_32.test(raw)) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export interface ProviderCredentials { clientId: string; clientSecret: string }

/** A provider's client id and secret, or null when either is missing. */
export function providerCredentials(provider: CalendarProvider): ProviderCredentials | null {
  const [clientId, clientSecret] = provider === 'google'
    ? [config.googleCalendarClientId, config.googleCalendarClientSecret]
    : [config.microsoftCalendarClientId, config.microsoftCalendarClientSecret];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export type CalendarOffReason = 'switched_off' | 'no_key' | 'no_provider';

export interface CalendarSyncState {
  enabled: boolean;
  providers: CalendarProvider[];
  /** Why it is off, for the start-up log only: never sent to a client. */
  offReason?: CalendarOffReason;
}

export function calendarSyncState(): CalendarSyncState {
  if (config.calendarSync !== 'on') return { enabled: false, providers: [], offReason: 'switched_off' };
  if (!calendarTokenKey()) return { enabled: false, providers: [], offReason: 'no_key' };
  const providers = CALENDAR_PROVIDERS.filter((p) => providerCredentials(p) !== null);
  if (providers.length === 0) return { enabled: false, providers: [], offReason: 'no_provider' };
  return { enabled: true, providers };
}

/** Whether this provider can be connected right now (the feature is on and the provider is configured). */
export function providerAvailable(provider: CalendarProvider): boolean {
  const state = calendarSyncState();
  return state.enabled && state.providers.includes(provider);
}

/** The address the browser starts at and the provider returns to: CALENDAR_REDIRECT_BASE, else API_BASE_URL. */
export function calendarRedirectBase(): string {
  return (config.calendarRedirectBase || config.apiBaseUrl).replace(/\/+$/, '');
}

/** The redirect URI registered with the provider (Google Cloud and Microsoft Entra must list exactly this). */
export function calendarCallbackUrl(provider: CalendarProvider): string {
  return `${calendarRedirectBase()}/api/calendar/${provider}/callback`;
}

/**
 * Said once at start-up: whether calendar free/busy is on, and when it was asked for but stays off, why (a missing or
 * malformed key, no provider credentials). Never the key or a secret.
 */
export function logCalendarSyncState(): void {
  const state = calendarSyncState();
  if (state.enabled) {
    logger.info({ providers: state.providers }, 'Calendar free/busy is on');
  } else if (state.offReason === 'no_key') {
    logger.error('CALENDAR_SYNC is on but CALENDAR_TOKEN_KEY is missing or is not 32 bytes in base64: calendar free/busy stays off');
  } else if (state.offReason === 'no_provider') {
    logger.error('CALENDAR_SYNC is on but no calendar provider has both a client id and a secret: calendar free/busy stays off');
  }
}
