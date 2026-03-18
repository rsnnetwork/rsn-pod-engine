import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query } from '../db';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// GET /notifications — last 20 for current user
// For invite-type notifications, includes invite status so the client knows
// whether to show Accept/Decline buttons.
router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query<any>(
        `SELECT n.id, n.type, n.title, n.body, n.link, n.is_read AS "isRead", n.created_at AS "createdAt",
                i.status AS "inviteStatus"
         FROM notifications n
         LEFT JOIN invites i ON n.type IN ('pod_invite', 'event_invite')
           AND n.link LIKE '/invite/%'
           AND i.code = SUBSTRING(n.link FROM '/invite/(.+)$')
         WHERE n.user_id = $1
         ORDER BY n.created_at DESC
         LIMIT 20`,
        [req.user!.userId]
      );

      const unreadCount = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
        [req.user!.userId]
      );

      const response: ApiResponse = {
        success: true,
        data: {
          notifications: result.rows,
          unreadCount: parseInt(unreadCount.rows[0]?.count || '0', 10),
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/:id/read — mark one as read
router.post(
  '/:id/read',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user!.userId]
      );
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/read-all — mark all as read
router.post(
  '/read-all',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
        [req.user!.userId]
      );
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
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
