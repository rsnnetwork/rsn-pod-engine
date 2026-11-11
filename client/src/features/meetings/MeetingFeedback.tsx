// client/src/features/meetings/MeetingFeedback.tsx
// Feedback on the meeting's own page (30 Oct 2026, item 5c): a "How did it go?" card once the meeting has started,
// until the viewer answers; the one who waited for someone who never came can answer here too. A link with ?feedback=1
// opens the question straight away (and, for someone who answered already, opens their answer to change it). Since
// 11 Nov 2026 leaving the room returns to the conversation instead, which asks there (PostCallFeedback).
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquareHeart } from 'lucide-react';
import type { Meeting } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { ACTION } from './MeetingParts';
import MeetingFeedbackSheet from './MeetingFeedbackSheet';
import { canGiveFeedback, cardLine, feedbackCardDue, CARD_TITLE } from './meeting-feedback';

export default function MeetingFeedback({ meeting, now }: { meeting: Meeting; now: number }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('feedback') === '1';
  const [opened, setOpened] = useState(false);
  const open = (opened || asked) && canGiveFeedback(meeting, now);

  const close = () => {
    setOpened(false);
    if (asked) {
      const next = new URLSearchParams(params);
      next.delete('feedback');
      setParams(next, { replace: true });
    }
  };

  return (
    <>
      {feedbackCardDue(meeting, now) && (
        <section aria-labelledby="meeting-feedback-title" className="mb-4 flex flex-col gap-3 rounded-2xl border border-[#ffc9c4] bg-reason-pink/60 p-4 min-[721px]:flex-row min-[721px]:items-center">
          <MessageSquareHeart aria-hidden="true" className="hidden h-6 w-6 shrink-0 text-reason-red-hover min-[721px]:block" />
          <div className="min-w-0 flex-1">
            <h2 id="meeting-feedback-title" className="text-[17px] font-extrabold">{CARD_TITLE}</h2>
            <p className="mt-0.5 text-[14px] text-[#4b5260] [overflow-wrap:anywhere]">{cardLine(meeting.partner.displayName)}</p>
          </div>
          <button type="button" onClick={() => setOpened(true)} className={cn(ACTION, 'bg-reason-red text-white hover:bg-reason-red-hover')}>
            Answer
          </button>
        </section>
      )}
      <MeetingFeedbackSheet open={open} meeting={meeting} onClose={close} />
    </>
  );
}
