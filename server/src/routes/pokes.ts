// ─── Poke Routes ───────────────────────────────────────────────────────────
//
// Phase G of chat-fix-and-dm-system plan (1 May 2026). REST surface for
// the poke layer.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as pokeService from '../services/poke/poke.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const sendBodySchema = z.object({
  recipientId: z.string().uuid(),
  message: z.string().max(500).optional(),
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

// POST /pokes/:id/accept — accept a poke (recipient only)
router.post(
  '/:id/accept',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.acceptPoke(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /pokes/:id/decline — decline a poke (recipient only)
router.post(
  '/:id/decline',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pokeService.declinePoke(req.params.id, req.user!.userId);
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

export default router;
