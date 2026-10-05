// ─── People (REASON milestone 1, 29 Sep 2026) ────────────────────────────────
// PUT    /people/:userId/response  { response: 'saved' | 'passed' }
// DELETE /people/:userId/response
// POST   /people/:userId/outcome   { worthContinuing, outcomes[] }
// (Task A5 adds the brief and /people/connections/recent.)

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, OUTCOME_KEYS, PERSON_RESPONSES, WORTH_CONTINUING } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { peopleWriteLimiter } from '../middleware/rateLimit';
import { fanoutUserEntity } from '../realtime/fanout';
import * as responses from '../services/people/person-response.service';
import * as outcomes from '../services/people/meeting-outcome.service';

const router = Router();

// Postgres reads an upper-case uuid as the same member, but the services compare
// ids as plain strings (yourself, the ordered pair), so the id is lower-cased here.
const userParams = z.object({ userId: z.string().uuid('Not a member id').transform((s) => s.toLowerCase()) });
// The accepted values are the shared lists, the same ones the database CHECK holds.
const responseBody = z.object({ response: z.enum(PERSON_RESPONSES) });
const outcomeBody = z.object({
  worthContinuing: z.enum(WORTH_CONTINUING),
  outcomes: z.array(z.enum(OUTCOME_KEYS)).max(OUTCOME_KEYS.length).default([]),
});
// validate() has already replaced req.body with the parsed value, but Express types it any.
type ResponseBody = z.infer<typeof responseBody>;
type OutcomeBody = z.infer<typeof outcomeBody>;

// Every write here changes only the member's own view. fanoutUserEntity emits
// user:<id>, which their For You, profile brief and side panels listen on.

router.put(
  '/:userId/response',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  validate(responseBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { response }: ResponseBody = req.body;
      await responses.setResponse(req.user!.userId, req.params.userId, response);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { response } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:userId/response',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await responses.clearResponse(req.user!.userId, req.params.userId);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { response: null } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:userId/outcome',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  validate(outcomeBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: OutcomeBody = req.body;
      const data = await outcomes.recordOutcome(
        req.user!.userId, req.params.userId, body.worthContinuing, body.outcomes,
      );
      void fanoutUserEntity(req.user!.userId);
      res.status(201).json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
