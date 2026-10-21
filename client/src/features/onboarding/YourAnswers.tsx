// Screen 7, "Your answers": the four questions, what they said to each, and
// [Edit], which opens that question and comes back here. What they would like
// to meet and what they are hoping to find are theirs alone, and say so.

import type { OnboardingV2Answers } from '@rsn/shared';
import OnlyYou from './OnlyYou';
import { PROFILE, QUESTIONS, answerSummary, questionProblem, type QuestionStepKey } from './flow';

interface Props {
  answers: OnboardingV2Answers;
  onEdit: (step: QuestionStepKey) => void;
}

export default function YourAnswers({ answers, onEdit }: Props) {
  return (
    <section aria-labelledby="your-answers">
      <h2 id="your-answers" className="font-display text-lg font-bold">{PROFILE.answers}</h2>
      <ol className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {QUESTIONS.map((q, i) => {
          const summary = answerSummary(q, answers);
          const specific = q.step === 'q2' ? (answers.findSpecific ?? '').trim() : '';
          const open = questionProblem(q, answers) !== null;
          return (
            <li key={q.step} className={`flex items-start gap-3 px-4 py-3 ${i ? 'border-t border-gray-100' : ''}`} data-testid={`answer-${q.step}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{q.number}. {q.title}</p>
                {q.onlyYou && <OnlyYou className="mt-1" />}
                {summary && <p className="mt-1 break-words text-sm text-gray-600">{summary}</p>}
                {specific && <p className="mt-1 break-words text-sm text-gray-600">“{specific}”</p>}
                {open && <p className="mt-1 text-sm font-medium text-rsn-red">This one still needs an answer.</p>}
              </div>
              <button
                type="button"
                onClick={() => onEdit(q.step)}
                aria-label={`${PROFILE.edit}: ${q.title}`}
                className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg px-3 text-sm font-semibold text-rsn-red hover:bg-rsn-red-light focus:outline-none focus-visible:ring-2 focus-visible:ring-rsn-red"
              >
                {PROFILE.edit}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
