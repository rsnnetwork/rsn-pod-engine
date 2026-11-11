// ─── People's answers on the matching board (Part 3 Task 10) ────────────────────────────────────────────────────────
// The board page reads the event's questions (useEventQuestions); the server puts everyone's answers in that read for
// organisers only. The page hands each seat its person's answers through this context, so the rooms, the basket and a
// person's meetings show them without every component in between passing them on. The default answers nothing: a chip
// drawn outside the board (or for anyone the server gave no answers) shows none.
import { createContext } from 'react';
import type { EventQuestionsView } from '@rsn/shared';
import { answerLabelsFor, answerLinesFor } from '../sessions/questions/question-form';

export interface BoardAnswers {
  /** Short chips: "Health", "AI". */
  labelsFor: (userId: string) => string[];
  /** A line per answered question: "Which sector?" → ["Health"]. */
  linesFor: (userId: string) => Array<{ prompt: string; labels: string[] }>;
}

export const NO_BOARD_ANSWERS: BoardAnswers = { labelsFor: () => [], linesFor: () => [] };

export const BoardAnswersContext = createContext<BoardAnswers>(NO_BOARD_ANSWERS);

/** The context's value for an organiser's read of the questions (no `answers` in it: nothing to show). */
export function boardAnswersOf(view: EventQuestionsView | undefined): BoardAnswers {
  if (!view?.answers || view.answers.length === 0) return NO_BOARD_ANSWERS;
  return { labelsFor: (userId) => answerLabelsFor(view, userId), linesFor: (userId) => answerLinesFor(view, userId) };
}
