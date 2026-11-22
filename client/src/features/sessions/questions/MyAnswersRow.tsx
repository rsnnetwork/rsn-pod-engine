// ─── "Your answers" on the event page (Part 3 Task 10) ──────────────────────────────────────────────────────────────
// For someone with a place, a request or a waiting-list number on an event that asks extra matching questions, before
// it goes live (the server locks answers then): their own answers, and Change answers (the sheet in 'edit' mode). Only
// their own: the read carries nobody else's answers for them.
import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import type { EventQuestionsView } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { QUIET_BUTTON } from '../organiser-ui';
import MyEventAnswersSheet from './MyEventAnswersSheet';
import { QUESTIONS_COPY, myAnswerLines } from './question-form';

interface Props {
  sessionId: string;
  view: EventQuestionsView | undefined;
}

export default function MyAnswersRow({ sessionId, view }: Props) {
  const [open, setOpen] = useState(false);
  if (!view || view.questions.length === 0) return null;
  const lines = myAnswerLines(view);

  return (
    <Card data-testid="my-answers-row" className="!p-4 animate-fade-in-up stagger-1">
      <div className="flex flex-wrap items-center gap-3">
        <ListChecks className="h-5 w-5 shrink-0 text-rsn-red" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold text-[#1a1a2e]">{QUESTIONS_COPY.yourAnswers}</p>
          {lines.length > 0 ? (
            <ul className="text-sm text-gray-600">
              {lines.map((line) => <li key={line} className="[overflow-wrap:anywhere]">{line}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">{QUESTIONS_COPY.notAnswered}</p>
          )}
        </div>
        <button type="button" data-testid="my-answers-change" onClick={() => setOpen(true)} className={QUIET_BUTTON}>
          {QUESTIONS_COPY.changeAnswers}
        </button>
      </div>
      <MyEventAnswersSheet sessionId={sessionId} open={open} onClose={() => setOpen(false)} mode="edit" />
    </Card>
  );
}
