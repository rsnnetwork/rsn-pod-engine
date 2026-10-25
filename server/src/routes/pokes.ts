// ─── Poke Routes ───────────────────────────────────────────────────────────
//
// Phase G of chat-fix-and-dm-system plan (1 May 2026). REST surface for
// the poke layer.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as pokeService from '../services/poke/poke.service';
import { REQUEST_MESSAGE_MAX } from '../services/poke/request-message';
import { fanoutUserEntity } from '../realtime/fanout';
import { E } from '../realtime/entities';
import { NotFoundError } from '../middleware/errors';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const sendBodySchema = z.object({
  // Lower-cased: Postgres reads an upper-case uuid as the same member, but sendPoke
  // compares ids as plain strings (yourself, blocked, already declined).
  recipientId: z.string().uuid().transform((s) => s.toLowerCase()),
  message: z.string().max(REQUEST_MESSAGE_MAX).optional(),
});

// POST /pokes — send a poke
router.post(
  '/',
  authenticate,
  validate(sendBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.sendPoke(
        req.user!.userId, req.body.recipientId, req.body.message,
      );
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// A request id that is not a UUID used to reach SQL and come back as a Postgres 500.
const requestParams = z.object({ id: z.string().uuid('Not a request id') });

/**
 * Everyone whose screens show a request just answered: both people's request
 * lists (user, invites) and both bells. 25 Oct 2026: the bells were left out, so
 * the recipient's bell row for the request (now marked read, now Accepted or
 * Declined) only caught up on the next poll, and the other tabs never did.
 */
function tellBothAboutAnswer(senderId: string, recipientId: string): void {
  for (const userId of [senderId, recipientId]) {
    fanoutUserEntity(userId, [E.userInvites(userId), E.userNotifications(userId)]).catch(() => {});
  }
}

// POST /pokes/:id/accept — accept a poke (recipient only). Accepting a request
// that is already accepted is a 200 with the same conversation (a stale bell or
// card lands in the thread); accepting a declined one is the service's 409
// MEETING_REQUEST_ALREADY_ANSWERED, whose details.status says which answer it has.
router.post(
  '/:id/accept',
  authenticate,
  validate(requestParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.acceptPoke(req.params.id, req.user!.userId);
      // Phase May-19 realtime — ping the original sender's user-room
      // so their "Poke pending" badge flips to "Connected" + a new
      // conversation thread appears. acceptPoke itself only mutates
      // the DB; pre-fix the sender saw nothing until they refreshed.
      // 22 Sep 2026: this emitted only E.user(...), but both request queries
      // declare meta.entities = [E.userInvites(...)], so neither side's list
      // actually refetched — the answered request sat there until a reload.
      // The accepter's own other tabs need the same ping so their
      // pending-request inbox decrements.
      tellBothAboutAnswer(result.poke.senderId, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /pokes/:id/decline — decline a poke (recipient only). Declining twice is a
// 200; declining an accepted request is the service's 409, as for accept.
router.post(
  '/:id/decline',
  authenticate,
  validate(requestParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.declinePoke(req.params.id, req.user!.userId);
      // Phase May-19 realtime — same fanout shape as accept so the
      // sender's badge updates and the decliner's other tabs flip too.
      // Tags only: the sender is still never TOLD of a decline (no bell, no email).
      tellBothAboutAnswer(result.senderId, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /pokes/with/:userId — where a meeting request between us stands, so a
// profile can show "Request sent" or "They asked to meet you" instead of a
// dead button. Declared BEFORE /received would ever be reachable as a param;
// both are literal paths, so order is not load-bearing, but keep them adjacent.
router.get(
  '/with/:userId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.getPokeWith(req.user!.userId, req.params.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /pokes/received — list pending pokes I've received
router.get(
  '/received',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.listReceivedPokes(req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /pokes/has-pending/:userId — has the current user already poked target?
router.get(
  '/has-pending/:userId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hasPending = await pokeService.hasPendingPoke(req.user!.userId, req.params.userId);
      const response: ApiResponse = { success: true, data: { hasPending } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /pokes/:id — where ONE request stands, for either person in it.
//
// Registered LAST, after every literal path above, because '/:id' would
// otherwise swallow '/received' and '/has-pending/:userId'. A member reaching
// an already-answered request can be sent to the conversation instead of a
// dead end (22 Sep 2026).
router.get(
  '/:id',
  authenticate,
  validate(z.object({ id: z.string().uuid('Not a request id') }), 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await pokeService.getPokeState(req.params.id, req.user!.userId);
      if (!state) throw new NotFoundError('Meeting request', req.params.id);
      const response: ApiResponse = { success: true, data: state };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
