// client/src/features/calendar/calendar-words.ts
// Calendar free/busy (Shirley pilot S8, 12 Nov 2026; brief RSN 10; plan decision D7): the words and the busy-time rules.
// Pure on purpose (no React, axios, store, router or alias), so a test can run them:
// server/src/__tests__/client/shirley-s8-calendar-client.test.ts.
//
// The brief's distinction is kept in every sentence: CONNECTING a calendar (REASON sees when you are busy) is not the
// calendar INVITATION REASON emails when a meeting is booked, nor the calendar FILE a meeting page offers.

export type CalendarProviderName = 'google' | 'microsoft';

export const PROVIDER_LABEL: Record<CalendarProviderName, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook / Microsoft 365',
};

export const CONNECT_LABEL: Record<CalendarProviderName, string> = {
  google: 'Connect Google Calendar',
  microsoft: 'Connect Outlook / Microsoft 365',
};

/** The consent sheet, read before anyone leaves for Google or Microsoft. */
export const CONSENT_TITLE = 'Connect your calendar?';
export const CONSENT_READS = 'REASON will see only when you are busy or free in your main calendar, for the next few weeks.';
export const CONSENT_NEVER = 'REASON never sees what your events are: not their titles, who is in them, where they are or any notes.';
export const CONSENT_USE = 'We use it only to shade the times you are busy while you choose times to meet. Nobody else sees it, not even the person you are meeting.';
export const CONSENT_OPTIONAL = 'It is optional: you can book meetings without it. You can disconnect at any time in Settings.';
export const CONSENT_NOT_INVITE = 'This is not the calendar invitation REASON emails you when a meeting is booked. That arrives either way.';
export const CONSENT_LINES = [CONSENT_READS, CONSENT_NEVER, CONSENT_USE, CONSENT_OPTIONAL, CONSENT_NOT_INVITE] as const;
export const continueLabel = (p: CalendarProviderName) => `Continue to ${p === 'google' ? 'Google' : 'Microsoft'}`;

/** Settings. */
export const CARD_TITLE = 'Calendars';
export const CARD_INTRO = 'Optional. Connect a calendar to see when you are busy while you choose times to meet. REASON reads busy and free times of your main calendar only, never what your events are.';
export const NEEDS_RECONNECT = 'REASON can no longer read this calendar. Connect it again to keep seeing when you are busy.';
export const DISCONNECT_TITLE = 'Disconnect this calendar?';
export const disconnectBody = (p: CalendarProviderName) =>
  `REASON will stop reading when you are busy in your ${PROVIDER_LABEL[p]} and forget its access. Meetings you booked and their invitations stay as they are.`;
/** After disconnecting a Microsoft calendar: Microsoft has no call that lets REASON drop its own access. */
export const MICROSOFT_REMOVE_HINT = 'Disconnected. To remove REASON from your Microsoft account too, open account.live.com/consent/Manage (personal) or myapps.microsoft.com (work or school).';

/** The meeting picker. */
export const PICKER_HINT = 'Connect your calendar to see when you are busy (optional)';
export const PICKER_LEGEND = 'Striped times are busy in your calendar. You can still pick them.';
export const PICKER_UNAVAILABLE = 'We could not read your calendar just now. Times are shown without it.';
export const PICKER_RECONNECT = 'Your calendar needs connecting again to show when you are busy.';
export const BUSY_CELL_WORD = 'Busy';
/** Added to a busy cell's screen-reader words. */
export const BUSY_ARIA_SUFFIX = ', busy in your calendar';

/** What the app says when the browser comes back from Google or Microsoft (?calendar=...). */
export type ConnectOutcome = 'finish' | 'cancelled' | 'failed' | 'try_again' | 'admin';
export const OUTCOME_MESSAGE: Record<Exclude<ConnectOutcome, 'finish'>, { text: string; tone: 'info' | 'error' }> = {
  cancelled: { text: 'No problem, no calendar was connected.', tone: 'info' },
  failed: { text: 'We could not connect your calendar. Please try again.', tone: 'error' },
  try_again: { text: 'That calendar connection was started in another browser. Please connect again here.', tone: 'error' },
  admin: { text: 'Your organisation needs an administrator to approve REASON before you can connect this calendar.', tone: 'error' },
};
export const connectedMessage = (p: CalendarProviderName) => `${PROVIDER_LABEL[p]} connected. Busy times now show when you choose times to meet.`;

export const isOutcome = (v: string | null): v is ConnectOutcome =>
  v === 'finish' || v === 'cancelled' || v === 'failed' || v === 'try_again' || v === 'admin';
export const isProviderName = (v: string | null): v is CalendarProviderName => v === 'google' || v === 'microsoft';

// ---- busy times ----------------------------------------------------------------------------------------------------

/** How far ahead the picker asks: today and the next seven days (the picker offers seven days on any clock). */
export const BUSY_DAYS = 8;
const HOUR_MS = 3_600_000;

/**
 * The range the picker asks for: from the start of this UTC hour, eight days on. Moving only once an hour keeps the
 * question the same while the picker stays open, so the server's five-minute cache answers it.
 */
export function busyRange(now: number): { from: string; to: string } {
  const from = Math.floor(now / HOUR_MS) * HOUR_MS;
  return { from: new Date(from).toISOString(), to: new Date(from + BUSY_DAYS * 24 * HOUR_MS).toISOString() };
}

export interface BusyInterval { start: string; end: string }

/** Which of these 30-minute slots (UTC instants, "2026-11-12T09:00:00Z") overlap a busy interval, even by a minute. */
export function busySlotKeys(slots: readonly string[], busy: readonly BusyInterval[], slotMinutes = 30): Set<string> {
  const spans = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const out = new Set<string>();
  if (spans.length === 0) return out;
  for (const key of slots) {
    const start = Date.parse(key);
    if (!Number.isFinite(start)) continue;
    const end = start + slotMinutes * 60_000;
    if (spans.some((s) => s.start < end && s.end > start)) out.add(key);
  }
  return out;
}

/** The dismissed picker hint, remembered per member on this device. */
export const hintDismissedKey = (userId: string) => `rsn:calendar-hint-dismissed:${userId}`;

/** A return path for the browser to come back to after the provider: this page, without old calendar outcomes. */
export function returnPathFrom(pathname: string, search: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(search);
  for (const k of ['calendar', 'calendarProvider', 'calendarTicket']) params.delete(k);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const q = params.toString();
  return `${pathname}${q ? `?${q}` : ''}`;
}
