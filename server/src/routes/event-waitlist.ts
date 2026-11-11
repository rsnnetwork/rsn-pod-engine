// ─── An event's waiting list (10 Nov 2026 spec, Part 3 Task 3) ───────────────
// Mounted at /api/sessions beside the event routes. Joining the line is the registration's own: POST /:id/register with
// `waitlist: true`, the RSN Call link's entry, an approval or an invite accepted on a full event.
//
// DELETE /sessions/:id/waitlist/mine            take myself off the line                 (anyone on it; guests too)
// GET    /sessions/:id/waitlist                 the line, in order (500 at most)         (organisers)
// POST   /sessions/:id/waitlist/:userId/admit   "Let in now": a place over capacity      (organisers)
// DELETE /sessions/:id/waitlist/:userId         take someone off the line                (organisers)
//
// Organisers are the people who answer the event's requests (managesRequests). The service decides who may do each and
// tells the screens (session:<id>:waitlist and the event's own fan-out) after its write has committed.

import { Router, Request, Response, NextFunction } from 'express';
import type { ApiResponse, UserRole } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { waitlistLimiter } from '../middleware/rateLimit';
import * as waitlist from '../services/session/event-waitlist.service';
import type { Actor } from '../services/roles/actor';

const router = Router();

const actorOf = (req: Request): Actor => ({ userId: req.user!.userId, role: req.user!.role as UserRole });
const eventId = uuidInPath('id', PATH_REFUSALS.event);
const personId = uuidInPath('userId', "That person is not on this event's waiting list.");

router.delete(
  '/:id/waitlist/mine',
  authenticate,
  eventId,
  waitlistLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await waitlist.leaveWaitlist(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id/waitlist',
  authenticate,
  eventId,
  waitlistLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entries = await waitlist.listWaitlist(req.params.id, actorOf(req));
      const response: ApiResponse = { success: true, data: entries };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/waitlist/:userId/admit',
  authenticate,
  eventId,
  personId,
  waitlistLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await waitlist.admitFromWaitlist(req.params.id, actorOf(req), req.params.userId);
      const response: ApiResponse = { success: true, data: { userId: req.params.userId, admitted: true } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:id/waitlist/:userId',
  authenticate,
  eventId,
  personId,
  waitlistLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await waitlist.removeFromWaitlist(req.params.id, actorOf(req), req.params.userId);
      const response: ApiResponse = { success: true, data: { userId: req.params.userId, removed: true } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
