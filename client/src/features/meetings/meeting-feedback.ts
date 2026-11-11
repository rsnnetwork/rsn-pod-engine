// client/src/features/meetings/meeting-feedback.ts
// Feedback after a meeting (30 Oct 2026, item 5c): the words the sheet and the card say, when they show, and where the
// room sends someone who leaves it. Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/meeting-feedback-ui.test.ts.
//
// Asked when someone leaves the 1:1 room after the other person had been in it with them (over the conversation they
// return to, since 11 Nov 2026), and as a card on the meeting's page until they answer. Never rung as a bell.
import {
  MEETING_PROBLEMS, MEETING_PROBLEM_LABELS, MEETING_PROBLEM_TEXT_MAX,
  type Meeting, type MeetingFeedbackBody, type MeetingProblem, type WorthContinuing,
} from '@rsn/shared';

export const feedbackTitle = (name: string): string => `How did your meeting with ${name} go?`;
export const WORTH_QUESTION = 'Worth continuing?';
export const PROBLEMS_QUESTION = 'Any problems?';
export const PROBLEM_TEXT_LABEL = 'Anything you want to tell us (optional)';
export const reportLine = (name: string): string => `You can also report ${name}.`;
export const FEEDBACK_PRIVACY = 'Only you and the REASON team see this.';
export const CARD_TITLE = 'How did it go?';
export const cardLine = (name: string): string => `Tell us how your meeting with ${name} went.`;
export const FEEDBACK_SAVED = 'Thanks. Your feedback is saved.';
/** The sheet's way out (11 Nov 2026, RSN 08): feedback is optional, never a step to get past. */
export const NOT_NOW = 'Not now';
export const ANSWER_LATER = 'You can answer later from the meeting in Events.';
export const PROBLEM_TEXT_MAX = MEETING_PROBLEM_TEXT_MAX;

export const WORTH_OPTIONS: ReadonlyArray<{ key: WorthContinuing; label: string }> = [
  { key: 'yes', label: 'Yes' }, { key: 'maybe', label: 'Maybe' }, { key: 'no', label: 'No' },
];
export const PROBLEM_OPTIONS: ReadonlyArray<{ key: MeetingProblem; label: string }> =
  MEETING_PROBLEMS.map((key) => ({ key, label: MEETING_PROBLEM_LABELS[key] }));

/** Feedback can be given once the meeting has started (also when the other person never came), unless it was cancelled. */
export function canGiveFeedback(meeting: Pick<Meeting, 'status' | 'startAt'>, now: number): boolean {
  return meeting.status === 'scheduled' && Date.parse(meeting.startAt) <= now;
}

/** The meeting page's "How did it go?" card: until the viewer has answered. */
export function feedbackCardDue(meeting: Pick<Meeting, 'status' | 'startAt' | 'myFeedback'>, now: number): boolean {
  return canGiveFeedback(meeting, now) && !meeting.myFeedback;
}

/** A problem on or off, kept in the sheet's own order. */
export function toggleProblem(picked: readonly MeetingProblem[], key: MeetingProblem): MeetingProblem[] {
  const next = picked.includes(key) ? picked.filter((p) => p !== key) : [...picked, key];
  return MEETING_PROBLEMS.filter((p) => next.includes(p));
}

/** What Send posts: the problems only when there are some, the text only when it says something. */
export function feedbackBody(worth: WorthContinuing, problems: readonly MeetingProblem[], text: string): MeetingFeedbackBody {
  const trimmed = text.trim().slice(0, MEETING_PROBLEM_TEXT_MAX);
  return {
    worthContinuing: worth,
    ...(problems.length ? { problems: [...problems] } : {}),
    ...(trimmed ? { problemText: trimmed } : {}),
  };
}

/**
 * Where leaving the 1:1 room goes (11 Nov 2026, Shirley Palmer's RSN 08): back to the conversation, always. When the
 * other person had been in the room and the meeting is known, the question comes with it as ?feedback=<meetingId>, which
 * the thread asks over itself as an optional sheet. It never goes to the meeting's page: that page's Back returned
 * into the call.
 */
export function afterRoomPath(opts: { conversationId: string; meetingId?: string | null; hadPartner: boolean }): string {
  const thread = `/messages/${opts.conversationId}`;
  if (opts.hadPartner && opts.meetingId) return `${thread}?feedback=${encodeURIComponent(opts.meetingId)}`;
  return thread;
}

/**
 * afterRoomPath, decided as the person leaves (1 Nov 2026, fix round 2). The other person counts as having been in the
 * room when the room said so earlier (`hadPartner`) or when they are in it as I leave (`partnerHere`: their tile is on
 * my screen). The meeting is the one the scheduler's read named; when that read gave none (it failed, or had not
 * answered yet), a scheduled room reads it once more (`readMeetingId`), and a read that fails or finds none goes to
 * the chat. Nothing is read for a room nobody else came into. The read is given LEAVE_READ_MS.
 */
export async function afterRoomLeave(opts: {
  conversationId: string;
  meetingId?: string | null;
  hadPartner: boolean;
  partnerHere: boolean;
  readMeetingId?: () => Promise<string | null | undefined>;
}): Promise<string> {
  const hadPartner = opts.hadPartner || opts.partnerHere;
  if (!hadPartner) return afterRoomPath({ conversationId: opts.conversationId, hadPartner });
  const meetingId = opts.meetingId || (opts.readMeetingId ? await boundedRead(opts.readMeetingId) : null);
  return afterRoomPath({ conversationId: opts.conversationId, meetingId, hadPartner });
}

/**
 * How long the leave waits on that read (fix round 3), with the call still running; a read still unanswered by then
 * goes to the chat, as a failed one does (axios alone would wait 60 s). Since the leave fix (1 Nov 2026) the room's
 * own departure (call-presence.ts leaveCall, at most DEPART_MS) runs beside it, so pressing leave waits for whichever
 * of the two takes longer.
 */
export const LEAVE_READ_MS = 3_000;

/** The read's answer, or null once it fails or has taken LEAVE_READ_MS. */
function boundedRead(read: () => Promise<string | null | undefined>): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LEAVE_READ_MS); });
  return Promise.race([read().catch(() => null), gaveUp]).finally(() => clearTimeout(timer));
}
