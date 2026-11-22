// ─── Notification Preferences Routes ───────────────────────────────────────
//
// 22 Nov 2026: the three email settings join the switches (notification-prefs.service.ts): email_away_only,
// email_max_per_day (1, 3, 5 or 10 only) and weekly_digest. A save is rate limited and tells the member's other
// screens (user:<id>:notification-prefs), so Settings open in another tab shows the change without a refresh.
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { notificationPrefsLimiter } from '../middleware/rateLimit';
import * as prefsService from '../services/notification-prefs/notification-prefs.service';
import { emitEntities, getRealtimeIo } from '../realtime/emit';
import { E } from '../realtime/entities';
import { ApiResponse } from '@rsn/shared';
import logger from '../config/logger';

const router = Router();

export const updateSchema = z.object({
  dm_bell: z.boolean().optional(),
  dm_email: z.boolean().optional(),
  poke_bell: z.boolean().optional(),
  poke_email: z.boolean().optional(),
  group_bell: z.boolean().optional(),
  group_email: z.boolean().optional(),
  invite_bell: z.boolean().optional(),
  invite_email: z.boolean().optional(),
  report_resolved_bell: z.boolean().optional(),
  report_resolved_email: z.boolean().optional(),
  email_away_only: z.boolean().optional(),
  email_max_per_day: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)]).optional(),
  weekly_digest: z.boolean().optional(),
});

router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prefs = await prefsService.getPrefs(req.user!.userId);
      const response: ApiResponse = { success: true, data: prefs };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/',
  authenticate,
  notificationPrefsLimiter,
  validate(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const saved = await prefsService.updatePrefs(userId, req.body);
      const response: ApiResponse = { success: true, data: saved };
      res.json(response);
      emitEntities(getRealtimeIo(), [userId], [E.userNotificationPrefs(userId)])
        .catch((err) => logger.warn({ err, userId }, 'notification prefs entity emit failed (non-fatal)'));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
