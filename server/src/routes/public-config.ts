// ─── What this server has switched on, for the client (Shirley pilot S8, 12 Nov 2026) ─────────────────────────────────
//
// Mounted at /api/public/config, open signed out (it says nothing about anyone):
//   GET /   { calendar: { enabled, providers } }   whether calendar free/busy is on, and which providers can be connected
// The client hides every calendar control while `enabled` is false. Never a key, a secret or why it is off.

import { Router, Request, Response } from 'express';
import type { ApiResponse, PublicConfig } from '@rsn/shared';
import { publicConfigLimiter } from '../middleware/rateLimit';
import { calendarSyncState } from '../services/calendar-sync/settings';

const router = Router();

router.get('/', publicConfigLimiter, (_req: Request, res: Response) => {
  const { enabled, providers } = calendarSyncState();
  const data: PublicConfig = { calendar: { enabled, providers } };
  res.json({ success: true, data } satisfies ApiResponse);
});

export default router;
