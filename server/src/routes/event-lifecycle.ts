// ─── An event's lifecycle (Part 2 foundation, Task 2) ────────────────────────
// POST   /sessions/:id/publish             a draft is published
// POST   /sessions/:id/unpublish           back to a draft, while nobody has registered
// POST   /sessions/:id/cancel              { reason?: string <= 500 }; everyone who held a place is told
// POST   /sessions/:id/archive             an event that ended or was cancelled is put away
// DELETE /sessions/:id/archive             and brought back
// POST   /sessions/:id/delete-permanently  { confirmTitle }: a super admin, typing the event's name
//
// Mounted at /api/sessions beside the event routes. Who may take which step, and in which state, is the service's
// (event-lifecycle.service.ts, over the shared allowedLifecycleActions); every step tells every screen there.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { EVENT_CANCEL_REASON_MAX } from '@rsn/shared';
import type { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { lifecycleWriteLimiter } from '../middleware/rateLimit';
import * as lifecycle from '../services/session/event-lifecycle.service';
import { DELETE_TITLE_MISMATCH } from '../services/session/event-lifecycle.service';
import type { Actor } from '../services/roles/actor';

const router = Router();

const REASON_TOO_LONG = `Keep the reason to ${EVENT_CANCEL_REASON_MAX} characters.`;
const cancelBody = z.object({
  reason: z.string().trim().max(EVENT_CANCEL_REASON_MAX, REASON_TOO_LONG).optional(),
});
const deleteBody = z.object({
  confirmTitle: z.string({ required_error: DELETE_TITLE_MISMATCH }).max(400, DELETE_TITLE_MISMATCH),
});

function actorOf(req: Request): Actor {
  return { userId: req.user!.userId, role: req.user!.role };
}

type Step = (req: Request) => Promise<unknown>;

/** One lifecycle route: signed in, counted, a valid event id (and body), the step, then `{ success, data }`. */
function stepRoute(step: Step, ...bodyCheck: ReturnType<typeof validate>[]) {
  return [
    authenticate, lifecycleWriteLimiter, uuidInPath('id', PATH_REFUSALS.event), ...bodyCheck,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const data = await step(req);
        res.json({ success: true, data } satisfies ApiResponse);
      } catch (err) {
        next(err);
      }
    },
  ];
}

router.post('/:id/publish', ...stepRoute(async (req) => {
  await lifecycle.publishEvent(req.params.id, actorOf(req));
  return { publication: 'published' };
}));

router.post('/:id/unpublish', ...stepRoute(async (req) => {
  await lifecycle.unpublishEvent(req.params.id, actorOf(req));
  return { publication: 'draft' };
}));

router.post('/:id/cancel', ...stepRoute(async (req) => {
  const reason = (req.body as z.infer<typeof cancelBody>).reason ?? null;
  return lifecycle.cancelEvent(req.params.id, actorOf(req), reason);
}, validate(cancelBody, 'body', REASON_TOO_LONG)));

router.post('/:id/archive', ...stepRoute(async (req) => {
  await lifecycle.archiveEvent(req.params.id, actorOf(req));
  return { archived: true };
}));

router.delete('/:id/archive', ...stepRoute(async (req) => {
  await lifecycle.unarchiveEvent(req.params.id, actorOf(req));
  return { archived: false };
}));

router.post('/:id/delete-permanently', ...stepRoute(async (req) => {
  await lifecycle.deleteEventPermanently(req.params.id, actorOf(req), (req.body as z.infer<typeof deleteBody>).confirmTitle);
  return { deleted: true };
}, validate(deleteBody, 'body', DELETE_TITLE_MISMATCH)));

export default router;
