import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { validate } from '../middleware/validate';
import { notificationPageLimiter } from '../middleware/rateLimit';
import { query } from '../db';
import { fanoutOwnNotifications } from '../realtime/fanout';
import {
  NOTIFICATION_BELL_COUNT, NOTIFICATION_PAGE_DEFAULT, NOTIFICATION_PAGE_MAX, decodeNotificationCursor, listNotifications,
} from '../services/notifications/notification-list.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const PAGE_GONE = 'That page of notifications could not be found. Open the list again.';

// ?before=<cursor from the last page>&limit=1..50. Both optional: with neither, the bell's newest 20 exactly as before.
const listQuery = z.object({
  before: z.string().max(200, PAGE_GONE).refine((c) => decodeNotificationCursor(c) !== null, PAGE_GONE).optional(),
  limit: z.coerce.number({ invalid_type_error: 'Ask for between 1 and 50 notifications.' }).int()
    .min(1, 'Ask for between 1 and 50 notifications.').max(NOTIFICATION_PAGE_MAX, 'Ask for between 1 and 50 notifications.').optional(),
});

// GET /notifications — the member's notifications, newest first, with their unread count (services/notifications/
// notification-list.service.ts says what each row carries). With no query string: the newest 20, as the bell has always
// read them (production's bell is unchanged). The notifications page (30 Oct 2026) pages with ?before= and ?limit=
// (30 a page unless it asks, at most 50); every answer adds `nextBefore`, the cursor of the next older page or null.
router.get(
  '/',
  authenticate,
  notificationPageLimiter,
  validate(listQuery, 'query', 'We could not read that page of notifications.'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { before, limit } = req.query as unknown as z.infer<typeof listQuery>;
      const paging = before !== undefined || limit !== undefined;
      const data = await listNotifications(req.user!.userId, {
        before: before ? decodeNotificationCursor(before) : null,
        limit: limit ?? (paging ? NOTIFICATION_PAGE_DEFAULT : NOTIFICATION_BELL_COUNT),
      });
      const response: ApiResponse = { success: true, data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/read-all — mark all as read (MUST be before /:id/read)
router.post(
  '/read-all',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
        [req.user!.userId]
      );
      // Phase May-19 realtime — fan out to the user's own personal
      // room so any other tabs / devices the same user has open reset
      // the bell counter without a refresh.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/:id/read — mark one as read. A malformed id is a 400 in a member's words (26 Oct 2026).
router.post(
  '/:id/read',
  authenticate,
  uuidInPath('id', PATH_REFUSALS.notification),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user!.userId]
      );
      // Phase May-19 realtime — same own-room fanout so cross-tab bell
      // counter stays in sync.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /notifications — clear all notifications for current user
router.delete(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `DELETE FROM notifications WHERE user_id = $1`,
        [req.user!.userId]
      );
      // Phase May-19 realtime — clearing notifications also empties
      // the bell on other tabs.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
