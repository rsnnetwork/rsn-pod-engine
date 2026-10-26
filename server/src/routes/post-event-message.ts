// ─── Post-Event Broadcast Message Routes ─────────────────────────────────────
//
// Task 9 of the post-event-broadcast-messaging plan (May 2026).
// Exposes four endpoints for the broadcast-message feature:
//   GET  /sessions/:sessionId/post-event-message/eligibility
//   GET  /sessions/:sessionId/post-event-message/preview
//   POST /sessions/:sessionId/post-event-message
//   GET  /sessions/:sessionId/post-event-message/status
//
// Mounted at /api/sessions (alongside sessionRoutes) in index.ts.
// Uses mergeParams: true so :sessionId is visible on this router.
//
// Two versions share these paths (26 Oct 2026):
//   Version 1 — what production's client calls. Admins only; a fixed feedback template.
//   Version 2 — the organiser (host, co-host, pod director or host) or an admin writes the message and
//               it goes to everyone who took part, after the event ends. Reached only when the caller
//               asks: `?v=2` on the eligibility call, a `body` on the send. A call that asks for
//               neither is answered exactly as before.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { postEventMessageLimiter } from '../middleware/rateLimit';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors';
import { ErrorCodes, ApiResponse, UserRole, POST_EVENT_MESSAGE_LIMITS, type PostEventMessageJob } from '@rsn/shared';
import {
  getEligibilityForEvent,
  getEligibilityV2ForEvent,
} from '../services/post-event-message/broadcast-eligibility';
import {
  previewJob,
  createJob,
  createJobV2,
  conflictForActiveSend,
  getLatestJob,
  type SendInput,
} from '../services/post-event-message/post-event-message.service';
import { getEventOrganiserAccess } from '../services/post-event-message/event-organisers';
import { reportProgress, resolveProgressAudience } from '../services/post-event-message/send-progress';
import { getRealtimeIo } from '../realtime/emit';
import { query } from '../db';

const router = Router({ mergeParams: true });

// ─── The event id ─────────────────────────────────────────────────────────────
//
// An id that is not an id names no event. Without this the database answered it with a 500.

const sessionIdSchema = z.string().uuid();

router.param('sessionId', (_req, _res, next, sessionId: string) => {
  if (!sessionIdSchema.safeParse(sessionId).success) {
    next(new NotFoundError('Session'));
    return;
  }
  next();
});

// ─── Enabled guard (version 1) ────────────────────────────────────────────────
//
// v1: only admins are enabled; hosts/directors see coming-soon state via
// the eligibility endpoint but cannot call preview/create.

async function requireBroadcastEnabled(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const elig = await getEligibilityForEvent(
      req.user!.userId,
      req.user!.role as UserRole,
      req.params.sessionId,
    );
    if (!elig.enabled) {
      return next(
        new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'This feature is coming soon'),
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ─── Completed-event guard (inline helper) ────────────────────────────────────
//
// Returns the session row if status='completed', otherwise throws.
// Used inside preview and create handlers.

async function assertSessionCompleted(sessionId: string): Promise<void> {
  const result = await query<{ status: string }>(
    `SELECT status FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('Session', sessionId);
  }
  if (result.rows[0].status !== 'completed') {
    throw new AppError(
      409,
      ErrorCodes.VALIDATION_ERROR,
      'Post-event messages can only be sent for completed events',
    );
  }
}

// ─── Version 2 ────────────────────────────────────────────────────────────────

const NOT_AN_ORGANISER_SEND = 'Only the people running this event can message everyone.';
const NOT_AN_ORGANISER_STATUS = 'Only the people running this event can see this.';

const NEEDS_A_MESSAGE = 'Write a message first.';

/**
 * The body of a version 2 send. The text is the organiser's own and goes out as written, so the only
 * thing taken off is the space around it. It is capped by the same limit the screen counts with, and
 * must be a string the database can hold.
 */
const sendBodySchema = z.object({
  body: z
    .string({ required_error: NEEDS_A_MESSAGE, invalid_type_error: NEEDS_A_MESSAGE })
    .trim()
    .min(1, NEEDS_A_MESSAGE)
    .max(POST_EVENT_MESSAGE_LIMITS.bodyMax, `Messages can be up to ${POST_EVENT_MESSAGE_LIMITS.bodyMax} characters.`)
    .refine((text) => !text.includes('\u0000'), 'That message has a character that cannot be sent.'),
  includeNoShows: z
    .boolean({ invalid_type_error: 'Choose whether to include the people who did not come.' })
    .optional()
    .default(false),
});

function parseSendBody(payload: unknown): SendInput {
  const parsed = sendBodySchema.safeParse(payload ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue.message, { [issue.path.join('.') || '_root']: [issue.message] });
  }
  return parsed.data;
}

/**
 * A send is version 2 when it carries a `body`, or says `?v=2`. A forgotten body on `?v=2` is a 400,
 * never a quiet fall back to the template: that would message everyone with words nobody chose.
 */
function isVersion2Send(req: Request): boolean {
  const payload: unknown = req.body;
  const hasBody = typeof payload === 'object' && payload !== null && 'body' in payload;
  return req.query.v === '2' || hasBody;
}

/** Check the person may send now, make the job, and tell the people who run the event it started. */
async function sendOrganiserMessage(req: Request): Promise<PostEventMessageJob> {
  const input = parseSendBody(req.body);
  const { userId, role } = req.user!;
  const { sessionId } = req.params;

  const eligibility = await getEligibilityV2ForEvent(userId, role as UserRole, sessionId);
  if (eligibility.reason === 'not_organiser') throw new ForbiddenError(NOT_AN_ORGANISER_SEND);
  if (!eligibility.enabled) {
    // A send already going out says whose it is, so the person who pressed Send twice is not told that
    // somebody else is writing.
    throw eligibility.reason === 'sending'
      ? await conflictForActiveSend(sessionId, userId)
      : new ConflictError(ErrorCodes.VALIDATION_ERROR, eligibility.explanation);
  }

  const job = await createJobV2(sessionId, userId, input);
  await reportProgress(getRealtimeIo(), await resolveProgressAudience(sessionId, userId), sessionId);
  return job;
}

// ─── GET /:sessionId/post-event-message/eligibility ──────────────────────────
//
// No enabled-guard — callers need to query this to decide whether to show
// the button at all (visible vs enabled). Still requires auth.

router.get(
  '/:sessionId/post-event-message/eligibility',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.query.v === '2') {
        const eligibility = await getEligibilityV2ForEvent(
          req.user!.userId,
          req.user!.role as UserRole,
          req.params.sessionId,
        );
        const response: ApiResponse = { success: true, data: eligibility };
        res.json(response);
        return;
      }

      // Ensure the session exists (NotFound beats eligibility noise).
      const sessResult = await query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1`,
        [req.params.sessionId],
      );
      if (sessResult.rows.length === 0) {
        throw new NotFoundError('Session', req.params.sessionId);
      }

      const elig = await getEligibilityForEvent(
        req.user!.userId,
        req.user!.role as UserRole,
        req.params.sessionId,
      );
      const response: ApiResponse = { success: true, data: elig };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:sessionId/post-event-message/preview ──────────────────────────────
//
// Dry-run: classify recipients and return grouped counts. Sends nothing.

router.get(
  '/:sessionId/post-event-message/preview',
  authenticate,
  requireBroadcastEnabled,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertSessionCompleted(req.params.sessionId);
      const preview = await previewJob(req.params.sessionId);
      const response: ApiResponse = { success: true, data: preview };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:sessionId/post-event-message ─────────────────────────────────────
//
// Create a pending broadcast job. The background worker picks it up within ~10 s.
// A send with a `body` is version 2 and answers to the organiser rule; one without is the template
// send and still answers to the admin-only rule, so the guard stands aside only for version 2.

function requireBroadcastEnabledUnlessVersion2(req: Request, res: Response, next: NextFunction): void {
  if (isVersion2Send(req)) {
    next();
    return;
  }
  void requireBroadcastEnabled(req, res, next);
}

router.post(
  '/:sessionId/post-event-message',
  authenticate,
  postEventMessageLimiter,
  requireBroadcastEnabledUnlessVersion2,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (isVersion2Send(req)) {
        const response: ApiResponse = { success: true, data: await sendOrganiserMessage(req) };
        res.status(201).json(response);
        return;
      }

      await assertSessionCompleted(req.params.sessionId);
      const job = await createJob(req.params.sessionId, req.user!.userId);
      const response: ApiResponse = { success: true, data: job };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:sessionId/post-event-message/status ───────────────────────────────
//
// Returns the most-recent job for this event, or null if none exists yet. How many people were messaged
// and how many failed is for the people running the event and for admins; until 26 Oct any member could
// read it for any event.

router.get(
  '/:sessionId/post-event-message/status',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await getEventOrganiserAccess(
        req.user!.userId,
        req.user!.role as UserRole,
        req.params.sessionId,
      );
      if (!access) throw new NotFoundError('Session', req.params.sessionId);
      if (!access.isOrganiser) throw new ForbiddenError(NOT_AN_ORGANISER_STATUS);

      const job = await getLatestJob(req.params.sessionId);
      const response: ApiResponse = { success: true, data: job };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
