// ─── People (REASON milestone 1, 29 Sep 2026) ────────────────────────────────
// PUT    /people/:userId/response  { response: 'saved' | 'passed' }
// DELETE /people/:userId/response
// (Task A3 adds POST /people/:userId/outcome; Task A5 adds the brief and
//  /people/connections/recent.)

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { peopleWriteLimiter } from '../middleware/rateLimit';
import { fanoutUserEntity } from '../realtime/fanout';
import * as responses from '../services/people/person-response.service';

const router = Router();

const userParams = z.object({ userId: z.string().uuid('Not a member id') });
const responseBody = z.object({ response: z.enum(['saved', 'passed']) });

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
      await responses.setResponse(req.user!.userId, req.params.userId, req.body.response);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { response: req.body.response } } as ApiResponse);
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

export default router;
