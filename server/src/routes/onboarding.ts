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
import { requireRole } from '../middleware/rbac';
import { onboardingChatLimiter } from '../middleware/rateLimit';
import { query } from '../db';
import {
  ApiResponse,
  OnboardingMessage,
  OnboardingConfirmedProfile,
  OnboardingEnrichmentState,
  OnboardingOpening,
  UserRole,
} from '@rsn/shared';
import * as chatbot from '../services/onboarding/chatbot.service';
import * as intentRepo from '../services/onboarding/intent.repo';
import { inferKnownProfile } from '../services/onboarding/known';
import * as enrichment from '../services/onboarding/enrichment.service';
import * as enrichRepo from '../services/onboarding/enrichment.repo';
import { runEnrichment, isFreshCacheHit } from '../services/onboarding/enrichment.orchestrator';
import { resolveEnrichProvider, statusFromConfidence } from '../services/onboarding/providers/registry';
import { record as recordStageEvent, sanitizeErrorMessage } from '../services/onboarding/stage-events.repo';
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

function sendEnrichmentDisabled(res: Response): void {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'ENRICHMENT_DISABLED',
      message: 'Profile enrichment is unavailable right now. Please fill in your profile manually.',
    },
  };
  res.status(503).json(response);
}

// A failure and a genuine miss read identically to the member — the host still
// says "let's build it together" either way. The distinction (why it failed)
// stays admin-visible via enrichment.error, never surfaced in the `opening`.
function openingFromEnrichment(status: OnboardingEnrichmentState['status']): OnboardingOpening {
  switch (status) {
    case 'searching':
      return 'searching';
    case 'found':
      return 'found';
    case 'partial':
      return 'partial';
    case 'none':
    case 'not_found':
    case 'failed':
      return 'not_found';
    default:
      return 'not_found';
  }
}

// ─── GET /onboarding/status ──────────────────────────────────────────────────
router.get(
  '/status',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const [status, enrichmentState] = await Promise.all([
        intentRepo.getOnboardingStatus(userId),
        enrichRepo.getEnrichmentState(userId),
      ]);
      const enrichmentPayload: OnboardingEnrichmentState = {
        status: enrichmentState.status,
        error: enrichmentState.error,
        startedAt: enrichmentState.startedAt,
        completedAt: enrichmentState.completedAt,
      };
      // Surface the found/partial result to the client's confirm card: the 202
      // enrich contract carries no body, so the cached enriched profile (the
      // member's OWN data) rides along here — and ONLY on found/partial; every
      // other state stays candidate-free.
      if (enrichmentState.status === 'found' || enrichmentState.status === 'partial') {
        const cached = await enrichRepo.getCachedEnrichment(userId).catch(() => null);
        if (cached?.profile) enrichmentPayload.candidate = cached.profile;
      }
      const opening = openingFromEnrichment(enrichmentPayload.status);
      const response: ApiResponse = { success: true, data: { status, enrichment: enrichmentPayload, opening } };
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
// Kicks off (or reuses a cached) LinkedIn profile lookup as a BACKGROUND job —
// runEnrichment (A5) writes state transitions + the result blob itself and is
// fire-and-forget-safe (never throws), so this handler never waits on it. The
// client learns the outcome by polling the enrichment state (Task B2).
// Returns 202 { status: 'searching' } for a fresh run, or 200 { status } when
// a fresh 90-day cache already answers the question. 503 only when the
// resolved provider is 'none' (the rollback kill switch).
const enrichSchema = z.object({ linkedinUrl: z.string().trim().max(500).nullish() });
router.post(
  '/enrich',
  authenticate,
  onboardingChatLimiter,
  validate(enrichSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provider = resolveEnrichProvider();
      if (provider === 'none') {
        sendEnrichmentDisabled(res);
        return;
      }
      const userId = req.user!.userId;
      // Canonicalize member input — a bare "avivson" becomes the full profile URL,
      // so the URL-anchored search + cache comparison always see the same shape.
      // Falls back to a previously-known LinkedIn URL when none is supplied now.
      const known = await inferKnownProfile(req, userId);
      const reqLinkedin = enrichment.normalizeLinkedinUrl(req.body.linkedinUrl as string | null);
      const linkedinUrl = reqLinkedin || known.linkedin || null;

      const cached = await enrichRepo.getCachedEnrichment(userId).catch(() => null);
      if (isFreshCacheHit(cached, linkedinUrl)) {
        const response: ApiResponse = { success: true, data: { status: statusFromConfidence(cached!.confidence) } };
        res.json(response);
      } else {
        const response: ApiResponse = { success: true, data: { status: 'searching' } };
        res.status(202).json(response);
      }

      // Fire-and-forget: runEnrichment persists every transition (including
      // re-confirming the cache-hit path above) and never throws, but the
      // .catch() here is belt-and-braces against a truly unexpected rejection.
      runEnrichment(userId, { linkedinUrl, fullName: known.name || undefined }).catch((err) =>
        logger.error({ err, userId }, 'runEnrichment fire-and-forget rejected unexpectedly'),
      );
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
      const fields = { ...req.body, linkedin: enrichment.normalizeLinkedinUrl(req.body.linkedin as string | null) };
      await enrichRepo.applyEnrichedToProfile(req.user!.userId, fields);
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
      // E1: chat_started fires only when THIS call actually performed the
      // transition (the user's first turn), not on every subsequent turn.
      intentRepo
        .markInProgress(userId)
        .then((transitioned) => {
          if (transitioned) recordStageEvent(userId, 'chat_started').catch(() => {});
        })
        .catch((err) => logger.warn({ err, userId }, 'onboarding markInProgress failed'));

      const wrapMode: 'none' | 'soft' | 'hard' =
        req.body.hardFinish === true ? 'hard' : req.body.finish === true ? 'soft' : 'none';
      // Everything we already know (LinkedIn enrichment + saved fields) so the host
      // can answer "who am I", never re-ask, and personalise. Also the enrichment
      // state itself, so the honesty clause in the system prompt can tell the host
      // whether we actually retrieved anything (never pretend we did when we did not).
      const [hostKnown, enrichmentState] = await Promise.all([
        Promise.resolve(intentRepo.getKnownProfileForHost(userId)).catch(() => undefined),
        enrichRepo
          .getEnrichmentState(userId)
          .catch(() => ({ status: 'failed' as const, source: null, error: null, startedAt: null, completedAt: null })),
      ]);
      // Reply is converse ONLY — kept fast. The live card update runs as a separate
      // call (POST /onboarding/profile) so a slow extraction can never delay or cap
      // the reply, and the card fills reliably on every turn.
      let turn;
      try {
        turn = await chatbot.converse(messages, profile, wrapMode, hostKnown, enrichmentState.status);
      } catch (err) {
        // LLM down (exhausted credits, revoked key, outage) → 503 LLM_DISABLED so
        // the client falls back to the form. 2 Jul: prod credits ran out and this
        // surfaced as a raw 500 + a dead chat instead of the designed fallback.
        logger.error({ err, userId }, 'onboarding converse failed — sending LLM_DISABLED fallback');
        sendLlmDisabled(res);
        return;
      }
      const response: ApiResponse = { success: true, data: { reply: turn.reply, ready: turn.ready } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /onboarding/profile ────────────────────────────────────────────────
// Extract the running intent from the conversation and return a live profile for
// the card. Decoupled from /chat so the card fills reliably EVERY turn — no time
// cap, and a slow extraction never delays the host reply. Also persists the
// partial intent + transcript for resume. The client sends the full conversation
// (including the latest host reply) and uses the result to update the card.
router.post(
  '/profile',
  authenticate,
  onboardingChatLimiter,
  validate(messagesSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!chatbot.isEnabled()) {
        res.json({ success: true, data: { profile: null } } as ApiResponse);
        return;
      }
      const userId = req.user!.userId;
      const messages = req.body.messages as OnboardingMessage[];
      const intent = await chatbot.extractIntent(messages).catch((err) => {
        logger.warn({ err, userId }, 'onboarding live extraction failed');
        recordStageEvent(userId, 'extract_failed', { source: 'profile', message: sanitizeErrorMessage(err) }).catch(() => {});
        return null;
      });
      const liveProfile = intent ? chatbot.liveProfileFromIntent(intent) : null;
      res.json({ success: true, data: { profile: liveProfile } } as ApiResponse);

      // Persist the running intent + transcript in the background (resume + matching).
      if (intent) {
        intentRepo
          .savePartialIntent(userId, intent, messages)
          .catch((err) => logger.warn({ err, userId }, 'onboarding per-answer save failed'));
      }
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

      let intent;
      try {
        intent = await chatbot.extractIntent(messages);
      } catch (err) {
        // Same LLM-down mapping as /chat — the client falls back to the form
        // instead of a dead confirm button.
        logger.error({ err, userId }, 'onboarding confirm extraction failed — sending LLM_DISABLED fallback');
        recordStageEvent(userId, 'extract_failed', { source: 'confirm', message: sanitizeErrorMessage(err) }).catch(() => {});
        sendLlmDisabled(res);
        return;
      }
      // Snapshot what we inferred so confirmed-vs-guessed can be stored separately.
      const inferred = await inferKnownProfile(req, userId).catch(() => undefined);
      const { profileComplete } = await intentRepo.saveIntentAndComplete(
        userId,
        intent,
        messages,
        profile,
        inferred
      );
      recordStageEvent(userId, 'confirmed', intent.profileStrength ? { profileStrength: intent.profileStrength } : {}).catch(() => {});

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

// ─── POST /onboarding/admin/refresh-enrichment (admin only) ──────────────────
// Force a re-enrichment for a member: clears their cached enrichment, then
// fires the SAME background job POST /onboarding/enrich uses — runEnrichment
// (A5) — as a fire-and-forget call against the TARGET member's own linkedin_url
// + display_name (not the calling admin's; the member-facing /onboarding/enrich
// endpoint enriches whoever's token is on the request, so it cannot be reused
// here). This is the admin inspector's caller for that job (Task E3).
const refreshEnrichSchema = z.object({ userId: z.string().uuid() });
router.post(
  '/admin/refresh-enrichment',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(refreshEnrichSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.body.userId as string;
      await enrichRepo.clearEnrichment(userId);

      const target = await query<{ linkedin_url: string | null; display_name: string | null }>(
        `SELECT linkedin_url, display_name FROM users WHERE id = $1`,
        [userId],
      );
      const row = target.rows[0];
      const linkedinUrl = row?.linkedin_url ?? null;
      const fullName = row?.display_name || undefined;

      // Fire-and-forget, same discipline as /onboarding/enrich: runEnrichment
      // persists every state transition itself and never throws; the .catch()
      // here only guards a truly unexpected rejection.
      runEnrichment(userId, { linkedinUrl, fullName }).catch((err) =>
        logger.error({ err, userId }, 'admin refresh-enrichment: runEnrichment fire-and-forget rejected'),
      );

      const response: ApiResponse = { success: true, data: { cleared: true, status: 'searching' } };
      res.status(202).json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
