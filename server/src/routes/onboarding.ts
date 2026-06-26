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
import { ApiResponse, OnboardingMessage, OnboardingConfirmedProfile } from '@rsn/shared';
import * as chatbot from '../services/onboarding/chatbot.service';
import * as intentRepo from '../services/onboarding/intent.repo';
import { inferKnownProfile } from '../services/onboarding/known';
import * as enrichment from '../services/onboarding/enrichment.service';
import * as enrichRepo from '../services/onboarding/enrichment.repo';
import logger from '../config/logger';

const router = Router();

const profileSchema = z
  .object({
    name: z.string().trim().max(120).nullish(),
    firstName: z.string().trim().max(120).nullish(),
    country: z.string().trim().max(120).nullish(),
    company: z.string().trim().max(200).nullish(),
    role: z.string().trim().max(200).nullish(),
    linkedin: z.string().trim().max(500).nullish(),
  })
  .optional();

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
  profile: profileSchema,
  /** Member-initiated "I'm done" (soft): host asks one last skippable thing if missing. */
  finish: z.boolean().optional(),
  /** Second press / skip (hard): host wraps up unconditionally. */
  hardFinish: z.boolean().optional(),
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

// ─── GET /onboarding/known ───────────────────────────────────────────────────
// What we already know / can infer (name, email, country from IP, company from
// email domain) so the client can show a "confirm this" card instead of a form.
router.get(
  '/known',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const known = await inferKnownProfile(req, req.user!.userId);
      const response: ApiResponse = { success: true, data: known };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /onboarding/resume ──────────────────────────────────────────────────
// Lets a member continue an in-progress onboarding (loads the saved transcript).
router.get(
  '/resume',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const resume = await intentRepo.getResume(req.user!.userId);
      const response: ApiResponse = { success: true, data: resume };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /onboarding/enrich ─────────────────────────────────────────────────
// Look up the member's PUBLIC professional profile (LinkedIn URL if we have one,
// else name + company + country) via web search and return a candidate to confirm.
// Stores the candidate under inferred_profile; does NOT touch the live profile.
const enrichSchema = z.object({ linkedinUrl: z.string().trim().max(500).nullish() });
router.post(
  '/enrich',
  authenticate,
  onboardingChatLimiter,
  validate(enrichSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!enrichment.isEnrichmentEnabled()) {
        sendLlmDisabled(res);
        return;
      }
      const userId = req.user!.userId;
      const reqLinkedin = (req.body.linkedinUrl as string) || null;

      // Cache: reuse a prior lookup so reloads / re-tests don't re-run (and re-pay
      // for) a web search. Only re-search if the member supplied a NEW LinkedIn.
      const cached = await enrichRepo.getCachedEnrichment(userId).catch(() => null);
      if (cached && cached.confidence > 0) {
        const cachedLinkedin = cached.foundLinkedinUrl || cached.profile?.linkedinUrl || null;
        const sameLinkedin = !reqLinkedin || !cachedLinkedin || reqLinkedin === cachedLinkedin;
        if (sameLinkedin) {
          res.json({ success: true, data: cached } as ApiResponse);
          return;
        }
      }

      const known = await inferKnownProfile(req, userId);
      const result = await enrichment.enrichProfile({
        fullName: known.name || '',
        email: known.email,
        country: known.country,
        company: known.company,
        linkedinUrl: (reqLinkedin || known.linkedin || null),
      });
      if (result.confidence > 0) {
        await enrichRepo.saveEnrichedCandidate(userId, result).catch(() => {});
      }
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /onboarding/enrich/apply ───────────────────────────────────────────
// Write the member-confirmed/edited fields to the real profile (additive — only
// provided fields change; null leaves the existing value).
const applySchema = z.object({
  jobTitle: z.string().trim().max(200).nullish(),
  company: z.string().trim().max(200).nullish(),
  industry: z.string().trim().max(100).nullish(),
  location: z.string().trim().max(200).nullish(),
  bio: z.string().trim().max(2000).nullish(),
  linkedin: z.string().trim().max(500).nullish(),
});
router.post(
  '/enrich/apply',
  authenticate,
  validate(applySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await enrichRepo.applyEnrichedToProfile(req.user!.userId, req.body);
      const response: ApiResponse = { success: true, data: { applied: true } };
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
      const profile = req.body.profile as OnboardingConfirmedProfile | undefined;
      // Best-effort: nudge a fresh user into 'in_progress'. Never block the turn.
      intentRepo
        .markInProgress(userId)
        .catch((err) => logger.warn({ err, userId }, 'onboarding markInProgress failed'));

      const wrapMode: 'none' | 'soft' | 'hard' =
        req.body.hardFinish === true ? 'hard' : req.body.finish === true ? 'soft' : 'none';
      // Return the host reply as soon as it's ready — NEVER wait on extraction.
      // The per-answer extraction runs in the BACKGROUND (resume + matching), so a
      // slow or rate-limited extraction can't delay the chat reply.
      const { reply, ready } = await chatbot.converse(messages, profile, wrapMode);
      const response: ApiResponse = { success: true, data: { reply, ready } };
      res.json(response);

      const fullConversation: OnboardingMessage[] = [...messages, { role: 'assistant', content: reply }];
      chatbot
        .extractIntent(fullConversation)
        .then((intent) => intentRepo.savePartialIntent(userId, intent, fullConversation))
        .catch((err) => logger.warn({ err, userId }, 'onboarding per-answer extraction failed'));
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
      const profile = req.body.profile as OnboardingConfirmedProfile | undefined;

      const intent = await chatbot.extractIntent(messages);
      // Snapshot what we inferred so confirmed-vs-guessed can be stored separately.
      const inferred = await inferKnownProfile(req, userId).catch(() => undefined);
      const { profileComplete } = await intentRepo.saveIntentAndComplete(
        userId,
        intent,
        messages,
        profile,
        inferred
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
