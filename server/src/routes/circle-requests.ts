// ─── Asking for a new circle (Ben field test, 13 Nov 2026) ─────────────────────────────────────────────────────────
//
// Request, review, approve, create (circle-request.service.ts). Any member asks and sees their own asks; platform admins
// see the queue and answer. A route of its own (/api/circle-requests), so nothing here can be taken for a circle id by
// /api/circles/:id. Every write is rate limited and tells the people it touches (the service fans out).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { circleReadLimiter, circleRequestAskLimiter, circleWriteLimiter } from '../middleware/rateLimit';
import { ApiResponse, UserRole } from '@rsn/shared';
import * as requestService from '../services/circle/circle-request.service';

const router = Router();

const askBody = z.object({
  name: z.string({ required_error: 'Give the circle a name.' }).trim()
    .min(2, 'Give the circle a name of at least 2 characters.').max(120, 'Keep the name under 120 characters.'),
  description: z.string().trim().max(2000, 'Keep the description under 2000 characters.').optional().nullable(),
  purpose: z.string({ required_error: 'Say who the circle is for and why it should exist.' }).trim()
    .min(10, 'Say in a sentence who the circle is for and why it should exist.')
    .max(1000, 'Keep this under 1000 characters.'),
  joinPolicy: z.enum(['open', 'closed', 'invite_only'], { errorMap: () => ({ message: 'Choose who can join.' }) }).optional(),
});
const approveBody = z.object({
  name: z.string().trim().min(2, 'Give the circle a name of at least 2 characters.').max(120).optional(),
});
const declineBody = z.object({
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
});

const requestIdInPath = uuidInPath('id', PATH_REFUSALS.circleRequest);

// POST /circle-requests: a member asks for a new circle.
router.post('/', authenticate, circleRequestAskLimiter, validate(askBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await requestService.requestCircle(req.user!.userId, req.body);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circle-requests/mine: the member's own asks, newest first.
router.get('/mine', authenticate, circleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await requestService.listOwnRequests(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// DELETE /circle-requests/:id: the member withdraws their own waiting ask.
router.delete('/:id', authenticate, circleWriteLimiter, requestIdInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requestService.cancelOwnRequest(req.user!.userId, req.params.id);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circle-requests: the asks waiting for an answer (platform admins).
router.get('/', authenticate, circleReadLimiter, requireRole(UserRole.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await requestService.listPendingForReview();
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circle-requests/:id/approve: the circle is made, with the member who asked as its owner (platform admins).
router.post('/:id/approve', authenticate, circleWriteLimiter, requireRole(UserRole.ADMIN), requestIdInPath,
  validate(approveBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await requestService.approveRequest(req.user!.userId, req.params.id, { name: req.body.name });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circle-requests/:id/decline: no circle is made; the member is told, with the reason when one is given.
router.post('/:id/decline', authenticate, circleWriteLimiter, requireRole(UserRole.ADMIN), requestIdInPath,
  validate(declineBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requestService.declineRequest(req.user!.userId, req.params.id, { reason: req.body.reason });
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

export default router;
