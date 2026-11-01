// ─── Feedback after a meeting (30 Oct 2026, item 5c) ─────────────────────────
// "After a meeting ends, show a short prompt asking how it went and if there were any problems. Save the answers
// in the admin panel." Each person answers for themselves: Worth continuing? (the Foundation's Yes / Maybe / No)
// and Any problems?, with a few options and a line of text. It is stored in meeting_outcomes, beside the answers
// the profile's outcome sheet writes. Only the person who answers and the REASON team read it: the other person
// never sees it. The VALUES here are used by the client, so index.ts also gives each its own named re-export
// (Rollup CJS interop; see OPENINGS there).

import type { MeetingKind } from './meeting';
import type { OutcomeKey, WorthContinuing } from './reason';

/** "Any problems?" The CHECK in migration 123 is this list written out; migration-123.test.ts holds the two together. */
export const MEETING_PROBLEMS = ['audio', 'video', 'connection', 'behaviour', 'other'] as const;
export type MeetingProblem = (typeof MEETING_PROBLEMS)[number];

export const MEETING_PROBLEM_LABELS: Record<MeetingProblem, string> = {
  audio: 'Audio',
  video: 'Video',
  connection: 'Connection',
  behaviour: 'Behaviour',
  other: 'Other',
};

/**
 * Where an answer was given: after a 1:1 meeting, after an event, or after a direct call. A row the profile's
 * outcome sheet wrote has no source (NULL), and the admin list calls it "Profile".
 */
export const MEETING_FEEDBACK_SOURCES = ['meeting', 'event', 'instant'] as const;
export type MeetingFeedbackSource = (typeof MEETING_FEEDBACK_SOURCES)[number];

/** The longest problem text the server keeps. */
export const MEETING_PROBLEM_TEXT_MAX = 1000;

/** POST /api/meetings/:id/feedback */
export interface MeetingFeedbackBody {
  worthContinuing: WorthContinuing;
  problems?: MeetingProblem[];
  problemText?: string;
}

/** The viewer's own answer about a meeting, on GET /api/meetings/:id (`myFeedback`), null until they answer. */
export interface MyMeetingFeedback {
  worthContinuing: WorthContinuing;
  problems: MeetingProblem[];
  problemText: string | null;
}

/** What POST /api/meetings/:id/feedback answers: the answer as it is now stored. */
export interface SavedMeetingFeedback extends MyMeetingFeedback {
  id: string;
  meetingId: string;
  createdAt: string;
}

/** One person on an admin feedback row. A closed account reads "Former member"; its id still opens the inspector. */
export interface AdminFeedbackPerson {
  userId: string;
  displayName: string;
  isFormerMember: boolean;
}

/** One answer on GET /api/admin/feedback, with the other person's answer about the same meeting beside it. */
export interface AdminFeedbackRow {
  id: string;
  answeredAt: string;
  /** null: written by the profile's outcome sheet, with no meeting. */
  source: MeetingFeedbackSource | null;
  meeting: { id: string; startAt: string; durationMin: number; kind: MeetingKind } | null;
  from: AdminFeedbackPerson;
  about: AdminFeedbackPerson;
  answer: {
    worthContinuing: WorthContinuing;
    problems: MeetingProblem[];
    problemText: string | null;
    outcomes: OutcomeKey[];
  };
  /** What the other person said about the same meeting; null when they have not answered (or there is no meeting). */
  theirAnswer: { worthContinuing: WorthContinuing; problems: MeetingProblem[]; problemText: string | null } | null;
}

export interface AdminFeedbackPage {
  items: AdminFeedbackRow[];
  /** Pass back as `cursor` for the next page; null when this page is the last. */
  nextCursor: string | null;
}
