// ─── Event chat (26 Oct 2026) ────────────────────────────────────────────────
// The chat of an event, kept as it was sent, read back on the event's page.
//
// GET    /sessions/:id/chat?cursor=<epochMs>_<id>&limit=1..100   EventChatPage (newest page first)
// DELETE /sessions/:id/chat/:messageId                           take a message down  { ok: true }
//
// Mounted at /api/sessions beside the event routes. The service decides who may read and who may delete;
// the routes check the shape of what was sent and, after a delete, tell the people who read the chat.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ApiResponse, EventChatPage } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { eventChatReadLimiter, eventChatWriteLimiter } from '../middleware/rateLimit';
import { fanoutSessionChat } from '../realtime/fanout';
import { deleteEventChatMessage, listEventChat } from '../services/event-chat/event-chat.service';

const router = Router();

// Postgres reads an upper-case uuid as the same row, but the service compares ids as plain strings.
const eventParams = z.object({ id: z.string().uuid('Not an event id').transform((s) => s.toLowerCase()) });
const messageParams = eventParams.extend({
  messageId: z.string().uuid('Not a message id').transform((s) => s.toLowerCase()),
});
const pageQuery = z.object({
  cursor: z.string().regex(/^\d{1,15}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'That page of the chat could not be found.').optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
type PageQuery = z.infer<typeof pageQuery>;

// A read changes nothing, so it tells no screens.
router.get('/:id/chat', authenticate, eventChatReadLimiter, validate(eventParams, 'params'), validate(pageQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cursor, limit } = req.query as unknown as PageQuery;
      const data = await listEventChat(req.params.id, { id: req.user!.userId, role: req.user!.role }, { cursor, limit });
      res.json({ success: true, data } satisfies ApiResponse<EventChatPage>);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/chat/:messageId', authenticate, eventChatWriteLimiter, validate(messageParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const { deleted } = await deleteEventChatMessage(req.params.id, req.params.messageId, { id: me, role: req.user!.role });
      // A message already taken down changed nothing, so no screen needs telling.
      if (deleted) void fanoutSessionChat(req.params.id, me);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
