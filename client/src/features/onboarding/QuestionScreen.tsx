// Screens 3 to 6: one question in the shell, with "1 of 4" … "4 of 4" while
// they are going through. A single question opened from edit mode has no
// progress to show.

import type { ReactNode, Ref } from 'react';
import type { OnboardingV2Answers } from '@rsn/shared';
import OnboardingShell from './OnboardingShell';
import QuestionStep from './QuestionStep';
import { QUESTIONS, type Question } from './flow';

interface Props {
  question: Question;
  answers: OnboardingV2Answers;
  onChange: (next: OnboardingV2Answers) => void;
  ownWordsError: string | null;
  listError: string | null;
  ownWordsRef: Ref<HTMLInputElement>;
  guessed: boolean;
  showProgress: boolean;
  footer: ReactNode;
}

export default function QuestionScreen({ question, showProgress, footer, ...body }: Props) {
  return (
    <OnboardingShell
      pose="listening"
      sheepSize={72}
      progress={showProgress ? { current: question.number, total: QUESTIONS.length } : undefined}
      title={question.title}
      subtitle={question.hint}
      footer={footer}
    >
      <QuestionStep question={question} {...body} />
    </OnboardingShell>
  );
}
