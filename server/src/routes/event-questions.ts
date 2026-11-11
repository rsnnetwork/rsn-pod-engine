// ─── An event's extra matching questions (10 Nov 2026 spec, Part 3 Task 5; K5) ─────────────────────────────
//
// GET /sessions/:id/questions        EventQuestionsView: the questions, my answers, my unanswered required questions;
//                                    the people running it also get every person's answers and the counts
// PUT /sessions/:id/questions        the organiser saves the questions { questions } (an empty list removes them all)
// PUT /sessions/:id/questions/mine   a person saves their own answers { answers }
//
// Mounted at /api/sessions beside the groups routes. The routes check the shape of what was sent; the service decides
// who may read and change (organisers are canActAsHost, as for groups), refuses while the event is live, audits the
// organiser's changes, and tells the screens (session:<id>:questions). Answers are a soft preference only: they choose
// among the meetings the event already allows (MATCHING_QUESTIONS_RULING).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  MAX_EVENT_QUESTIONS, MAX_QUESTION_OPTIONS, QUESTION_LIMITS,
  type ApiResponse, type EventAnswers, type EventMatchingQuestion, type EventQuestionsView,
} from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { eventChatReadLimiter, groupsWriteLimiter } from '../middleware/rateLimit';
import { readEventQuestions, saveEventQuestions, saveMyAnswersAs } from '../services/session/event-questions.service';

const router = Router();

const uuid = (message: string) => z.string().uuid(message).transform((s) => s.toLowerCase());
const eventParams = z.object({ id: uuid('Not an event id') });

const key = (message: string) => z.string().regex(/^[a-z0-9_]{1,32}$/, message);

/**
 * A person's answers as any route takes them (the registration, the call link's entry, their own save): at most five
 * questions, at most eight answers each, every key a short name. The service then checks them against the event.
 */
export const eventAnswersSchema = z.record(
  z.string().max(QUESTION_LIMITS.keyMaxLength),
  z.array(z.string().max(QUESTION_LIMITS.keyMaxLength)).max(MAX_QUESTION_OPTIONS),
).refine((answers) => Object.keys(answers).length <= MAX_EVENT_QUESTIONS, `Answer at most ${MAX_EVENT_QUESTIONS} questions.`);

const questionBody = z.object({
  key: key('A question needs a short name made of letters and numbers.'),
  prompt: z.string().trim().min(1, 'Ask the question.').max(QUESTION_LIMITS.promptMaxLength),
  kind: z.enum(['single', 'multiple']),
  prefer: z.enum(['same', 'different']),
  required: z.boolean().default(false),
  options: z.array(z.object({
    key: key('An answer needs a short name made of letters and numbers.'),
    label: z.string().trim().min(1, 'Write the answer.').max(QUESTION_LIMITS.optionLabelMaxLength),
  })).max(MAX_QUESTION_OPTIONS),
});

const questionsBody = z.object({
  questions: z.array(questionBody).max(MAX_EVENT_QUESTIONS, `An event can ask at most ${MAX_EVENT_QUESTIONS} matching questions.`),
});
const mineBody = z.object({ answers: eventAnswersSchema });

const actorOf = (req: Request) => ({ userId: req.user!.userId, role: req.user!.role });

// A read changes nothing, so it tells no screens.
router.get('/:id/questions', authenticate, eventChatReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await readEventQuestions(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse<EventQuestionsView>);
    } catch (err) {
      next(err);
    }
  });

router.put('/:id/questions', authenticate, groupsWriteLimiter, validate(eventParams, 'params'), validate(questionsBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { questions } = req.body as z.infer<typeof questionsBody>;
      const data = await saveEventQuestions(req.params.id, actorOf(req), questions as EventMatchingQuestion[]);
      res.json({ success: true, data: { questions: data } } satisfies ApiResponse<{ questions: EventMatchingQuestion[] }>);
    } catch (err) {
      next(err);
    }
  });

router.put('/:id/questions/mine', authenticate, groupsWriteLimiter, validate(eventParams, 'params'), validate(mineBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { answers } = req.body as z.infer<typeof mineBody>;
      const { mine, missingRequired } = await saveMyAnswersAs(req.params.id, actorOf(req), answers);
      res.json({ success: true, data: { mine, missingRequired } } satisfies ApiResponse<{ mine: EventAnswers; missingRequired: string[] }>);
    } catch (err) {
      next(err);
    }
  });

export default router;
