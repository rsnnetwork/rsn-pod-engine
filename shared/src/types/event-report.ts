// ─── The organisers' event report (10 Nov 2026 spec, Part 3 item 3; plan K4) ─────────────────────────────────────
//
// GET /api/sessions/:id/report answers one of these to the people running the event: who registered and who came,
// who met whom in each round, how the ratings went in aggregate, and the pairs who both said they'd meet again.
// There are no money or ticket figures. By design there is no score a named person gave or received, no one-sided
// "meet again" and no private note: only counts, averages and the mutual pairs (both people opted in).
// Every time is an ISO instant; the event's own zone (`event.timezone`) is the clock the screens and the CSV use.

/** How a person's event went. `removed` (an organiser took their place away) is read before the rest. */
export type EventReportOutcome = 'stayed' | 'left_early' | 'could_not_join' | 'no_show' | 'removed';

/** The three CSV downloads. */
export type EventReportSection = 'attendance' | 'meetings' | 'mutual-matches';

export interface EventReportSummary {
  /** Places in the event, the host and co-hosts left out. */
  registered: number;
  /** Came at least once (a join time) and were not removed. */
  attended: number;
  /** Registered, never came, not removed. */
  noShows: number;
  removed: number;
  stayed: number;
  leftEarly: number;
  couldNotJoin: number;
  /** Event guests among `registered`. */
  guests: number;
  /** attended / registered; null when nobody registered. */
  attendanceRate: number | null;
  /** The rounds the event was set up with; null when its settings do not say. */
  roundsPlanned: number | null;
  /** Rounds with at least one matched meeting that took place (host breakout rooms aside). */
  roundsRun: number;
  /** Rooms that took place (completed or reassigned) with at least two people in them, breakout rooms included; a bye is not a meeting. */
  meetings: number;
  /** Host breakout rooms among `meetings`. */
  manualRooms: number;
  /** Different pairs of people who met, however many rounds they shared. */
  uniquePairsMet: number;
  /** One per person per partner per room: the ratings the event could have had. */
  ratingsExpected: number;
  ratingsSubmitted: number;
  /** ratingsSubmitted / ratingsExpected; null when none were expected. */
  ratingCompletion: number | null;
  /** The average 1-5 score, without the ratings marked "didn't work"; null when there is none. */
  avgQuality: number | null;
  /** How many scores were 1, 2, 3, 4 and 5, without the "didn't work" ones. */
  qualityDistribution: [number, number, number, number, number];
  /** Ratings marked "didn't work" (or filed on a room that never took place): kept out of the average. */
  didntWork: number;
  /** Share of the ratings that said "meet again"; null when there is none. */
  meetAgainRate: number | null;
  /** Different pairs who both said they'd meet again. */
  mutualMatches: number;
  /** People who wrote feedback about the event (the text is in the host's recap, not here). */
  feedbackCount: number;
  /** Versions of the matching board published. */
  scheduleVersionsPublished: number;
}

export interface EventReportPerson {
  userId: string;
  /** "Former member" for a closed, suspended or banned account; a guest who gave no name reads "Guest". */
  displayName: string;
  /** Only for the event's host, its co-hosts and admins; never for a former member. */
  email: string | null;
  accountKind: 'member' | 'event_guest';
  formerMember: boolean;
  role: 'host' | 'co_host' | 'participant';
  registeredAt: string;
  /** How the place was given (open, approval, invite, allow_list, code, audience, admin); null before admission modes. */
  admittedVia: string | null;
  /** The event's own groups the person is in. */
  groups: string[];
  joinedAt: string | null;
  leftAt: string | null;
  outcome: EventReportOutcome;
  /** Was not in an assigned room when a round started (at least once). */
  missedAMeeting: boolean;
  roundsCompleted: number;
  /** Rounds in which the person met at least one partner. */
  meetings: number;
  /** Different partners. */
  peopleMet: number;
  ratingsGiven: number;
  ratingsExpected: number;
  /** Different partners with whom both said they'd meet again. */
  mutualMatches: number;
}

export interface EventReportRound {
  round: number;
  rooms: number;
  /** Different people seated in the round's rooms (including anyone who left a room). */
  seated: number;
  /** Rooms with one person and no partner. */
  byes: number;
  completed: number;
  noShow: number;
  cancelled: number;
  reassigned: number;
  ratingsExpected: number;
  ratingsSubmitted: number;
  avgQuality: number | null;
  meetAgainRate: number | null;
  mutualPairs: number;
}

export interface EventReportMeeting {
  matchId: string;
  round: number;
  /** 1-based order within the round as the rooms were made; host breakout rooms after the matched ones. */
  room: number;
  /** The seats, in order (two, three, or one for a bye). */
  userIds: string[];
  /** People who were in the room and left it. */
  departedUserIds: string[];
  status: 'scheduled' | 'active' | 'completed' | 'no_show' | 'reassigned' | 'cancelled';
  how: 'matched' | 'host_edited' | 'manual_room' | 'board_manual' | 'board_repair';
  /** The published version of the matching board the room came from; null when the engine made it live. */
  scheduleVersion: number | null;
  startedAt: string | null;
  endedAt: string | null;
  ratingsExpected: number;
  ratingsSubmitted: number;
  mutualPairs: number;
}

/** Two people who both said they'd meet again, and the rounds in which they did. */
export interface EventReportMutualMatch {
  userIds: [string, string];
  rounds: number[];
}

export interface EventReport {
  event: {
    id: string;
    title: string;
    status: string;
    /** The event's IANA zone: every time in the report is shown on its clock. */
    timezone: string;
    scheduledAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
  };
  generatedAt: string;
  summary: EventReportSummary;
  /** Ordered by outcome, then name. */
  people: EventReportPerson[];
  rounds: EventReportRound[];
  /** Rooms that were set up but never ran ('scheduled') are left out. */
  meetings: EventReportMeeting[];
  mutualMatches: EventReportMutualMatch[];
}
