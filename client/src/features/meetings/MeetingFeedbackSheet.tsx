// client/src/features/meetings/MeetingFeedbackSheet.tsx
// "How did your meeting with {name} go?" (30 Oct 2026, item 5c; L11): Worth continuing? Yes / Maybe / No, and Any
// problems? Audio, Video, Connection, Behaviour, Other, with a text box. Send or Skip. Picking Behaviour offers the
// report. Only the person and the REASON team see it. A second answer edits the first: the sheet starts from it.
//
// On a phone the sheet scrolls inside itself with Send pinned at its foot (the REASON Sheet's footer), every chip 44px.
import { useEffect, useId, useRef, useState } from 'react';
import type { Meeting, MeetingProblem, WorthContinuing } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '@/features/reason/ui/Sheet';
import ReportUserModal from '@/components/ReportUserModal';
import { useSubmitMeetingFeedback } from './useMeetings';
import { meetingError } from './meeting-words';
import {
  feedbackBody, feedbackTitle, reportLine, toggleProblem, FEEDBACK_PRIVACY, FEEDBACK_SAVED, PROBLEM_OPTIONS,
  PROBLEM_TEXT_LABEL, PROBLEM_TEXT_MAX, PROBLEMS_QUESTION, WORTH_OPTIONS, WORTH_QUESTION,
} from './meeting-feedback';

const SKIP = 'min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold';
const SEND = 'min-h-[44px] rounded-[11px] bg-reason-red px-5 text-[14px] font-bold text-white enabled:hover:bg-reason-red-hover disabled:opacity-60';
const CHIP = 'min-h-[44px] rounded-full border px-3.5 text-[13px] font-bold';
// A selected chip's text is the darker red: the brand red on this pink is 4.15:1, under AA.
const chip = (selected: boolean) => cn(CHIP, selected ? 'border-reason-red bg-reason-pink text-reason-red-hover' : 'border-reason-line');

interface Props { open: boolean; meeting: Meeting; onClose: () => void }

export default function MeetingFeedbackSheet({ open, meeting, onClose }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const send = useSubmitMeetingFeedback(meeting.id);
  const name = meeting.partner.displayName;
  const hintId = useId();
  const textId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const [worth, setWorth] = useState<WorthContinuing | null>(null);
  const [problems, setProblems] = useState<MeetingProblem[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  // Each time the sheet opens it starts from the viewer's own answer, when there is one (a second press edits it).
  // Done while rendering, so the reopened sheet never shows a draft from before.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openKey = open ? meeting.id : null;
  if (openedFor !== openKey) {
    setOpenedFor(openKey);
    if (openKey) {
      setWorth(meeting.myFeedback?.worthContinuing ?? null);
      setProblems(meeting.myFeedback?.problems ?? []);
      setText(meeting.myFeedback?.problemText ?? '');
      setError(null);
      setReporting(false);
    }
  }
  // The error is the last thing in a body that scrolls: with the phone keyboard up it would land below the fold.
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  const submit = () => {
    if (!worth || send.isPending) return;
    setError(null);
    send.mutate(feedbackBody(worth, problems, text), {
      onSuccess: () => { addToast(FEEDBACK_SAVED, 'success'); onClose(); },
      onError: (err) => setError(meetingError(err, 'We could not send that just now. Try again in a moment.')),
    });
  };

  return (
    <>
      <Sheet
        open={open && !reporting}
        onClose={onClose}
        title={feedbackTitle(name)}
        footer={(
          <div className="flex w-full flex-col gap-2">
            <p className="text-[12px] text-reason-muted">{FEEDBACK_PRIVACY}</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={SKIP}>
                Skip
              </button>
              <button type="button" onClick={submit} disabled={!worth || send.isPending} aria-describedby={worth ? undefined : hintId} className={SEND}>
                {send.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}
      >
        <fieldset className="mt-3">
          <legend className="text-[13px] font-bold">{WORTH_QUESTION}</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {WORTH_OPTIONS.map((w) => (
              <button key={w.key} type="button" aria-pressed={worth === w.key} onClick={() => { setWorth(w.key); setError(null); }} className={chip(worth === w.key)}>
                {w.label}
              </button>
            ))}
          </div>
          {!worth && <p id={hintId} className="mt-1.5 text-[12px] text-reason-muted">Choose an answer first.</p>}
        </fieldset>
        <fieldset className="mt-4">
          <legend className="text-[13px] font-bold">{PROBLEMS_QUESTION}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {PROBLEM_OPTIONS.map((p) => (
              <button key={p.key} type="button" aria-pressed={problems.includes(p.key)} onClick={() => setProblems((now) => toggleProblem(now, p.key))} className={chip(problems.includes(p.key))}>
                {p.label}
              </button>
            ))}
          </div>
          {problems.includes('behaviour') && (
            <button
              type="button"
              onClick={() => setReporting(true)}
              className="mt-2 flex min-h-[44px] items-center text-left text-[13px] font-bold text-reason-red-hover underline underline-offset-2 [overflow-wrap:anywhere]"
            >
              {reportLine(name)}
            </button>
          )}
        </fieldset>
        <label htmlFor={textId} className="mt-4 block text-[13px] font-bold">{PROBLEM_TEXT_LABEL}</label>
        <textarea
          id={textId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={PROBLEM_TEXT_MAX}
          rows={3}
          className="mt-2 block min-h-[88px] w-full resize-y rounded-[11px] border border-reason-line px-3 py-2.5 text-[16px] leading-snug outline-none focus:border-reason-ink"
        />
        {error && <p ref={errorLine} role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
      </Sheet>
      <ReportUserModal
        open={reporting}
        onClose={() => setReporting(false)}
        reportedId={meeting.partner.userId}
        reportedDisplayName={name}
        conversationId={meeting.conversationId}
      />
    </>
  );
}
