// ─── People (REASON milestone 1, 29 Sep 2026) ────────────────────────────────
// GET    /people/connections        ?limit=30&before=<ISO>  (21 Oct 2026)
// GET    /people/connections/recent
// GET    /people/everyone           ?q&cursor&limit  (10 Nov 2026) every member you may meet, A to Z
// GET    /people/me/card            (21 Oct 2026) your own public card, exactly what others see
// GET    /people/:userId/brief
// PUT    /people/:userId/response  { response: 'saved' | 'passed' }
// DELETE /people/:userId/response
// PUT    /people/:userId/already-met   (10 Nov 2026) private "I met them outside REASON" marker
// DELETE /people/:userId/already-met
// POST   /people/:userId/outcome   { worthContinuing, outcomes[] }

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, OUTCOME_KEYS, PERSON_RESPONSES, WORTH_CONTINUING } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { peopleReadLimiter, peopleWriteLimiter } from '../middleware/rateLimit';
import { fanoutUserEntity } from '../realtime/fanout';
import { recomputeAgentsForUser } from '../services/matching/agent-matching.service';
import * as alreadyMet from '../services/people/already-met.service';
import * as responses from '../services/people/person-response.service';
import * as outcomes from '../services/people/meeting-outcome.service';
import * as brief from '../services/people/person-brief.service';
import * as connections from '../services/people/connections.service';
import * as everyone from '../services/people/everyone.service';
import { announceFeedbackToAdmins } from '../services/meetings/meeting-feedback.service';

const router = Router();

// Your connections, a page at a time: 30 people unless fewer are asked for, and never more than 50. `before` is
// the nextBefore of the page already shown, an ISO time.
const CONNECTIONS_PAGE = 30;
const CONNECTIONS_PAGE_MAX = 50;
const connectionsQuery = z.object({
  limit: z.coerce.number().int().min(1).optional()
    .transform((n) => Math.min(n ?? CONNECTIONS_PAGE, CONNECTIONS_PAGE_MAX)),
  before: z.string().datetime({ offset: true }).optional(),
});
type ConnectionsQuery = z.infer<typeof connectionsQuery>;

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

// The reads change nothing, so they emit nothing. They are limited per member all the
// same, and share one allowance: the brief can be aimed at any member by id. The two
// /connections routes come first so neither is ever taken for a member id.

router.get(
  '/connections',
  authenticate,
  peopleReadLimiter,
  validate(connectionsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has replaced req.query with the parsed value; Express still types it as raw strings.
      const { limit, before }: ConnectionsQuery = req.query as unknown as ConnectionsQuery;
      const data = await connections.listConnections(req.user!.userId, { limit, before: before ?? null });
      res.json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

const everyoneQuery = z.object({
  q: everyone.searchWord.optional(),
  cursor: z.string().min(1).max(600).refine((c) => !c.includes('\u0000')).optional(),
  limit: z.coerce.number().int().min(1).optional()
    .transform((n) => Math.min(n ?? everyone.EVERYONE_PAGE, everyone.EVERYONE_PAGE_MAX)),
});
type EveryoneQuery = z.infer<typeof everyoneQuery>;

router.get(
  '/everyone',
  authenticate,
  peopleReadLimiter,
  validate(everyoneQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, cursor, limit }: EveryoneQuery = req.query as unknown as EveryoneQuery;
      const data = await everyone.listEveryone(req.user!.userId, { q, cursor, limit });
      res.json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

router.get('/connections/recent', authenticate, peopleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await brief.listRecentConnections(req.user!.userId);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

// Your own profile, the way other members see it. It takes no id: it is always the signed-in member's card,
// through the same projection the brief uses for anyone else. It sits ahead of /:userId/brief with the other
// fixed paths; the brief goes on refusing your own id.
router.get('/me/card', authenticate, peopleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await brief.getOwnCard(req.user!.userId);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:userId/brief',
  authenticate,
  peopleReadLimiter,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await brief.getPersonBrief(req.user!.userId, req.params.userId);
      res.json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

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

// "Already met" (10 Nov 2026): private to the member who marks, so only their own tags are emitted. Marking
// twice, or unmarking someone not marked, changes nothing and still answers 200.
router.put(
  '/:userId/already-met',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await alreadyMet.markAlreadyMet(req.user!.userId, req.params.userId);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { alreadyMet: true } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:userId/already-met',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      await alreadyMet.unmarkAlreadyMet(userId, req.params.userId);
      void fanoutUserEntity(userId);
      // The member's searches kept no result for this person while they were marked: rescore them (it never
      // throws), then tell the member's screens again so the person is back without a refresh.
      void recomputeAgentsForUser(userId).then(() => fanoutUserEntity(userId));
      res.json({ success: true, data: { alreadyMet: false } } as ApiResponse);
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
      // The admin feedback list shows the profile sheet's answers too (as "Profile").
      void announceFeedbackToAdmins();
      res.status(201).json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
