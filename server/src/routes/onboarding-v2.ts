// ─── Onboarding v2 routes (Shradha's brief, 19 Oct 2026) ─────────────────────
//
//   GET  /api/onboarding/v2/state          → OnboardingV2State
//   PUT  /api/onboarding/v2/answers        → { saved: true }          (partial draft)
//   POST /api/onboarding/v2/linkedin       → OnboardingV2LinkedinResponse
//   POST /api/onboarding/v2/linkedin/skip  → { skipped: true }        ("Continue with email")
//   POST /api/onboarding/v2/confirm        → OnboardingV2ConfirmResponse
//
// Beside version 1 (routes/onboarding.ts), which is untouched and keeps
// serving the live app until go-live. Every route is authenticated, validated
// and rate limited, and every write tells the member's own screens through
// their user entity tag.

import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { onboardingAnswersLimiter, onboardingConfirmLimiter, onboardingLinkedinLimiter } from '../middleware/rateLimit';
import * as answersV2 from '../services/onboarding/answers-v2.repo';
import {
  draftSchemaV2, confirmSchemaV2, linkedinSchemaV2, skipSchemaV2, type ConfirmInputV2, type DraftInputV2,
} from '../services/onboarding/answers-v2.schema';
import { connectLinkedin } from '../services/onboarding/linkedin-v2';
import { useShownLinkedinPhoto } from '../services/onboarding/linkedin-photo';
import { syncSearchesFromV2Answers, type V2SearchResult } from '../services/matching/first-agent.service';
import { notifyMatchesOfNewUser } from '../services/matching/platform-match.service';
import { record as recordStageEvent } from '../services/onboarding/stage-events.repo';
import { tryGravatar } from '../services/onboarding/avatar.service';
import { fanoutUserEntity } from '../realtime/fanout';
import logger from '../config/logger';
import type { ApiResponse, OnboardingV2ConfirmResponse, OnboardingV2LinkedinResponse } from '@rsn/shared';

const router = Router();

router.get(
  '/state',
  authenticate,
  onboardingAnswersLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const state = await answersV2.getState(userId);
      // A photo costs them nothing and needs no question, as in v1.
      tryGravatar(userId).catch(() => {});
      const response: ApiResponse = { success: true, data: state };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/answers',
  authenticate,
  onboardingAnswersLimiter,
  validate(draftSchemaV2),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const patch = req.body as DraftInputV2;
      await answersV2.saveDraft(userId, patch);
      recordStageEvent(userId, 'answers_saved', { version: 2, step: patch.step ?? null });
      // Their own other tabs and devices follow the draft too.
      await fanoutUserEntity(userId);
      const response: ApiResponse = { success: true, data: { saved: true } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/linkedin',
  authenticate,
  onboardingLinkedinLimiter,
  validate(linkedinSchemaV2),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const out = await connectLinkedin(userId, req.body.url as string);
      recordStageEvent(userId, 'linkedin_connected', { lookup: out.decision, status: out.linkedin.status });
      // The address on their profile changed; the lookup tells them again when it ends.
      await fanoutUserEntity(userId);
      const data: OnboardingV2LinkedinResponse = { ...out.linkedin, linkedinUrl: out.linkedinUrl };
      const response: ApiResponse<OnboardingV2LinkedinResponse> = { success: true, data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/linkedin/skip',
  authenticate,
  onboardingAnswersLimiter,
  validate(skipSchemaV2),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      // Recording it is this endpoint's whole job, so it answers once it is recorded.
      // record() never throws.
      await recordStageEvent(userId, 'linkedin_skipped');
      await fanoutUserEntity(userId);
      const response: ApiResponse = { success: true, data: { skipped: true } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

/** The searches this confirm touched: the ones now searching first, then the paused ones. */
function searchesForResponse(results: V2SearchResult[]): OnboardingV2ConfirmResponse['agents'] {
  const searching = results.filter(r => r.change !== 'paused');
  const paused = results.filter(r => r.change === 'paused');
  return [...searching, ...paused].map(r => ({
    id: r.agent.id, label: r.agent.label, status: r.agent.status, change: r.change,
  }));
}

router.post(
  '/confirm',
  authenticate,
  onboardingConfirmLimiter,
  validate(confirmSchemaV2),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const input = req.body as ConfirmInputV2;
      const result = await answersV2.confirm(userId, input);

      // Only on a real change: pressing the button twice must not touch the
      // searches or tell the network again.
      let searches: V2SearchResult[] = [];
      if (result.firstCompletion || result.changed) {
        searches = await syncSearchesFromV2Answers(userId, result.answers.lookingToMeet, result.answers.meetOther);
        recordStageEvent(userId, 'confirmed', { version: 'onboarding_v2', kinds: result.answers.lookingToMeet });
      }

      // "Keep this photo": the photo the member was shown (the state's LinkedIn
      // prefill), never another one we hold and never a URL the client names.
      let photo: OnboardingV2ConfirmResponse['photo'] = null;
      if (input.profile?.useLinkedinPhoto) {
        const outcome = await useShownLinkedinPhoto(userId);
        photo = outcome === 'done' ? 'used' : outcome;
      }

      if (result.firstCompletion) {
        // Members whose searches this person answers hear about them, as in v1.
        notifyMatchesOfNewUser(userId).catch(err =>
          logger.warn({ err, userId }, 'newcomer fan-out failed (non-fatal)'));
      }

      // The gate is held in the client's auth store, which re-checks itself;
      // their other tabs only learn from this.
      await fanoutUserEntity(userId);
      const agents = searchesForResponse(searches);
      const data: OnboardingV2ConfirmResponse = {
        changed: result.changed,
        agents,
        primaryAgentId: agents.find(a => a.change !== 'paused')?.id ?? null,
        photo,
      };
      const response: ApiResponse<OnboardingV2ConfirmResponse> = { success: true, data };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
