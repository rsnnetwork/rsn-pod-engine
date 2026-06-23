// ─── Onboarding Chatbot Routes ───────────────────────────────────────────────
//
//   GET  /onboarding/status   → { status }            (drives the gate / resume)
//   POST /onboarding/chat     → { reply, ready }       (one host turn)
//   POST /onboarding/confirm  → { summary, profileComplete }  (extract + save)
//
// All require auth. /chat + /confirm are rate-limited and validated. When no
// Anthropic key is configured the chat endpoints return 503 LLM_DISABLED so the
// client falls back to the minimal form — signup is never blocked.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { onboardingChatLimiter } from '../middleware/rateLimit';
import { ApiResponse, OnboardingMessage } from '@rsn/shared';
import * as chatbot from '../services/onboarding/chatbot.service';
import * as intentRepo from '../services/onboarding/intent.repo';
import logger from '../config/logger';

const router = Router();

const messagesSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(4000),
      })
    )
    .min(1)
    .max(60),
});

function sendLlmDisabled(res: Response): void {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'LLM_DISABLED',
      message: 'Onboarding chat is unavailable right now. Please use the form.',
    },
  };
  res.status(503).json(response);
}

// ─── GET /onboarding/status ──────────────────────────────────────────────────
router.get(
  '/status',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const status = await intentRepo.getOnboardingStatus(req.user!.userId);
      const response: ApiResponse = { success: true, data: { status } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /onboarding/chat ───────────────────────────────────────────────────
router.post(
  '/chat',
  authenticate,
  onboardingChatLimiter,
  validate(messagesSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!chatbot.isEnabled()) {
        sendLlmDisabled(res);
        return;
      }
      const userId = req.user!.userId;
      const messages = req.body.messages as OnboardingMessage[];
      // Best-effort: nudge a fresh user into 'in_progress'. Never block the turn.
      intentRepo
        .markInProgress(userId)
        .catch((err) => logger.warn({ err, userId }, 'onboarding markInProgress failed'));

      const { reply, ready } = await chatbot.converse(messages);
      const response: ApiResponse = { success: true, data: { reply, ready } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /onboarding/confirm ────────────────────────────────────────────────
router.post(
  '/confirm',
  authenticate,
  onboardingChatLimiter,
  validate(messagesSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!chatbot.isEnabled()) {
        sendLlmDisabled(res);
        return;
      }
      const userId = req.user!.userId;
      const messages = req.body.messages as OnboardingMessage[];

      const intent = await chatbot.extractIntent(messages);
      const { profileComplete } = await intentRepo.saveIntentAndComplete(
        userId,
        intent,
        messages
      );

      const response: ApiResponse = {
        success: true,
        data: { summary: intent.userProfileSummary, profileComplete },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
