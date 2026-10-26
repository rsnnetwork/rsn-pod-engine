// ─── Meetings (26 Oct 2026, CON-04/05) ───────────────────────────────────────
// One confirmed 1:1 meeting between two members, as GET /api/meetings and the details page read it.
// The server stores only 'scheduled' or 'cancelled'; the phase is worked out from the time, by the
// rule below, so the server and the screens that redraw it as the clock moves agree to the minute.
// The VALUES here are used by the client, so index.ts also gives each its own named re-export
// (Rollup CJS interop; see OPENINGS there).

export type MeetingKind = 'audio' | 'video';
export type MeetingStatus = 'scheduled' | 'cancelled';
export type MeetingPhase = 'upcoming' | 'joinable' | 'live' | 'ended' | 'cancelled';
/** The three lists under Events: still to come (live and joinable included), over, and cancelled. */
export type MeetingScope = 'upcoming' | 'past' | 'cancelled';

export interface MeetingPartner {
  userId: string;
  /** "Former member" once their account is closed. */
  displayName: string;
  avatarUrl: string | null;
}

export interface Meeting {
  id: string;
  conversationId: string;
  partner: MeetingPartner;
  /** ISO instant; each screen draws it in its own time zone. */
  startAt: string;
  durationMin: number;
  kind: MeetingKind;
  status: MeetingStatus;
  phase: MeetingPhase;
  /** Why the two are meeting: the note on the request that connected them, when it had one. */
  context: string | null;
  /** The pair's own call room, the same place every Join has always opened. */
  joinPath: string;
  attended: { me: boolean; them: boolean };
}

export interface MeetingList {
  items: Meeting[];
  /** Pass back as `before` for the next page; null when this page is the last. */
  nextBefore: string | null;
}

export interface MeetingSummary {
  upcomingCount: number;
  /** A meeting can be joined right now. */
  liveNow: boolean;
  next: { id: string; startAt: string; partnerName: string } | null;
}

/** Join opens this many minutes before the start. */
export const MEETING_JOIN_EARLY_MIN = 5;
/** The room stays open this many minutes after the end (overruns, reconnects); after that it has ended. */
export const MEETING_GRACE_MIN = 30;

/**
 * The phase of a meeting at `now`: joinable from 5 minutes before the start, live from the start to
 * the end, joinable again for the 30 minutes after the end, ended after that. A cancelled meeting is
 * cancelled whatever the time.
 */
export function meetingPhase(
  meeting: { status: MeetingStatus; startAt: string | Date; durationMin: number },
  now: Date | number = Date.now(),
): MeetingPhase {
  if (meeting.status === 'cancelled') return 'cancelled';
  const at = typeof now === 'number' ? now : now.getTime();
  const start = new Date(meeting.startAt).getTime();
  const end = start + meeting.durationMin * 60_000;
  if (at < start - MEETING_JOIN_EARLY_MIN * 60_000) return 'upcoming';
  if (at < start) return 'joinable';
  if (at <= end) return 'live';
  if (at <= end + MEETING_GRACE_MIN * 60_000) return 'joinable';
  return 'ended';
}
