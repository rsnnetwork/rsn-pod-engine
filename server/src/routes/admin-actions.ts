// ─── Admin email-action routes ────────────────────────────────────────────
//
// Two endpoints, both unauthenticated (the token IS the auth):
//   GET  /:token         — peek; read-only, safe for email-crawler prefetch
//   POST /:token/confirm — finalise; atomic check-and-set
//
// The token is hashed before lookup; rate-limited; bound to (admin,
// request, action). 24h expiry. See admin-action-tokens.service.ts for
// the lifecycle.

import { Router, Request, Response, NextFunction } from 'express';
import { authLimiter } from '../middleware/rateLimit';
import { peekActionToken, confirmActionToken } from '../services/join-request/admin-action-tokens.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// Reuse the strict authLimiter — same threat profile (token guessing).
router.get('/:token', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const result = await peekActionToken(token);
    const response: ApiResponse<typeof result> = { success: true, data: result };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

router.post('/:token/confirm', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const result = await confirmActionToken(token);
    const response: ApiResponse<typeof result> = { success: true, data: result };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
