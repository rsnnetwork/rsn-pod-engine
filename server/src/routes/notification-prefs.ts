// ─── Notification Preferences Routes ───────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as prefsService from '../services/notification-prefs/notification-prefs.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const updateSchema = z.object({
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
  validate(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const next = await prefsService.updatePrefs(req.user!.userId, req.body);
      const response: ApiResponse = { success: true, data: next };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
