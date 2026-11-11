// ─── A person's answers as small chips, for the people running the event (Part 3 Task 10) ───────────────────────────
// Beside the group chip on the organiser's participant list. The labels come from answerLabelsFor, which reads only the
// organisers' `answers` (the server sends it to organisers alone), so for anyone else this draws nothing.
import type { EventQuestionsView } from '@rsn/shared';
import { answerLabelsFor } from './question-form';

export default function AnswerChips({ view, userId }: { view: EventQuestionsView | undefined; userId: string }) {
  const labels = answerLabelsFor(view, userId);
  if (labels.length === 0) return null;
  return (
    <span data-testid="participant-answer-chips" className="flex min-w-0 max-w-[14rem] flex-wrap gap-1">
      {labels.map((label, i) => (
        <span key={`${label}-${i}`} className="max-w-[10rem] truncate rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700">
          {label}
        </span>
      ))}
    </span>
  );
}
