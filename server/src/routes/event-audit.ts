// ─── Event audit trail (Part 2 foundation, Task 1) ───────────────────────────
// GET /sessions/:id/audit?cursor=<timestamp>|<id>&limit=1..100   { entries, nextCursor }, newest first
//
// Mounted at /api/sessions beside the event routes. Organisers (host, co-host, pod admin, super admin)
// and platform admins read it; nobody else. A read changes nothing, so it tells no screens.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { UserRole, hasRoleAtLeast } from '@rsn/shared';
import type { ApiResponse } from '@rsn/shared';
import { query } from '../db';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { eventAuditReadLimiter } from '../middleware/rateLimit';
import { ForbiddenError, NotFoundError } from '../middleware/errors';
import { canActAsHost } from '../services/roles/effective-role.service';
import { isEventAuditCursor, listEventAudit } from '../services/audit/event-audit';
import type { EventAuditRow } from '../services/audit/event-audit';

const router = Router();

const EVENT_AUDIT_FORBIDDEN = 'Only the people running this event can see its history.';

const eventParams = z.object({ id: z.string().uuid('Not an event id').transform((s) => s.toLowerCase()) });
const pageQuery = z.object({
  cursor: z.string().max(80).refine(isEventAuditCursor, 'That page of the history could not be found.').optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
type PageQuery = z.infer<typeof pageQuery>;

async function assertMayReadEventAudit(sessionId: string, userId: string, role: string): Promise<void> {
  if (hasRoleAtLeast(role as UserRole, UserRole.ADMIN)) {
    const found = await query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (found.rows.length === 0) throw new NotFoundError('Session', sessionId, 'This event could not be found.');
    return;
  }
  const { allowed } = await canActAsHost(userId, role, sessionId);
  if (!allowed) throw new ForbiddenError(EVENT_AUDIT_FORBIDDEN);
}

router.get('/:id/audit', authenticate, eventAuditReadLimiter, validate(eventParams, 'params'), validate(pageQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cursor, limit } = req.query as unknown as PageQuery;
      await assertMayReadEventAudit(req.params.id, req.user!.userId, req.user!.role);
      const data = await listEventAudit(req.params.id, { cursor, limit });
      res.json({ success: true, data } satisfies ApiResponse<{ entries: EventAuditRow[]; nextCursor: string | null }>);
    } catch (err) {
      next(err);
    }
  });

export default router;
