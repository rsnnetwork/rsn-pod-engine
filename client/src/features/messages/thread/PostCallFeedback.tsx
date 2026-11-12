// client/src/features/messages/thread/PostCallFeedback.tsx
// After a 1:1 call (11 Nov 2026, Shirley Palmer's RSN 08: "after hanging up, return to the previous thread; make feedback
// optional, dismissible and never a navigation trap"). Leaving the room lands on the conversation itself, with
// ?feedback=<meetingId> when the other person had been in it; this asks "How did your meeting with X go?" over the
// thread, as a sheet with "Not now". The thread stays usable behind it. It asks only while the meeting can take an
// answer and none has been given (an answer given already is changed on the meeting's own page); a meeting that cannot
// be read, is cancelled or was already answered asks nothing, and the flag is dropped either way (onDone, replacing the
// address), so Back or a refresh never asks again.
import { useEffect } from 'react';
import MeetingFeedbackSheet from '@/features/meetings/MeetingFeedbackSheet';
import { useMeeting } from '@/features/meetings/useMeetings';
import { feedbackCardDue } from '@/features/meetings/meeting-feedback';
import { isMeetingId } from '@/features/meetings/meeting-words';

export default function PostCallFeedback({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
  const valid = isMeetingId(meetingId);
  const { data: meeting, isError } = useMeeting(valid ? meetingId.toLowerCase() : null);
  const due = !!meeting && feedbackCardDue(meeting, Date.now());
  const settled = !valid || isError || (!!meeting && !due);
  useEffect(() => { if (settled) onDone(); }, [settled, onDone]);
  if (!meeting || !due) return null;
  return <MeetingFeedbackSheet open meeting={meeting} onClose={onDone} afterCall />;
}
