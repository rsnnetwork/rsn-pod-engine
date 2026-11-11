// ─── Calendar free/busy (Shirley pilot S8, 12 Nov 2026; brief RSN 10, plan decision D7) ───────────────────────────────
// A member may connect a Google or Microsoft calendar so the meeting picker shades the times they are already busy.
// Only busy and free times of the primary calendar are read: never an event's title, attendees, place or notes. It is
// optional, never needed to book, and dark until the server's CALENDAR_SYNC switch is on.
// Connecting a calendar is not the same as the calendar invitation REASON emails when a meeting is booked, nor the
// calendar file a meeting page offers.

export type CalendarProvider = 'google' | 'microsoft';

/** A connected calendar, as its owner sees it (never a token). */
export interface CalendarConnection {
  provider: CalendarProvider;
  /** The calendar account's address, shown so the member knows which account is connected. */
  accountEmail: string | null;
  /** `needs_reconnect`: the provider stopped accepting REASON's access (consent removed, expired): connect again. */
  status: 'active' | 'needs_reconnect';
  connectedAt: string;
}

/** One busy stretch, as UTC instants. No title, no attendees, no place: only when. */
export interface CalendarBusyInterval { start: string; end: string }

/** GET /api/calendar/busy: the caller's own busy times, merged across their connected calendars. */
export interface CalendarBusy {
  from: string;
  to: string;
  connected: Array<{ provider: CalendarProvider; status: CalendarConnection['status'] }>;
  busy: CalendarBusyInterval[];
  /** A calendar that could not be read just now (`unavailable`) or must be connected again (`reconnect`). */
  errors: Array<{ provider: CalendarProvider; code: 'unavailable' | 'reconnect' }>;
}

/** GET /api/public/config: what this server has switched on, for the client to show or hide. */
export interface PublicConfig {
  calendar: { enabled: boolean; providers: CalendarProvider[] };
}

/** DELETE /api/calendar/connections/:provider. */
export interface CalendarDisconnectResult {
  disconnected: true;
  /** Whether the provider was told to forget REASON's access too (Google can be; Microsoft has no such call). */
  revokedAtProvider: boolean;
}
