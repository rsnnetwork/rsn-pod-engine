// ─── The RSN Call link (Part 2 foundation, Task 6, 11 Nov 2026; spec 02, 04, 11) ───────────────────────────
//
// Mounted at /api/call-links (anyone holding a link; an event guest reaches all of it: guest-scope.ts):
//   GET  /me/events          the signed-in person's events by link (their place or their request)       authenticate
//   GET  /:code              the landing: the event as anyone holding the link sees it                   optionalAuth
//   POST /:code/email        { email, clientUrl? }  email a 6-digit entry code (its button opens clientUrl, else the
//                            request's Origin, when ours by sign-in's exact list; else CLIENT_URL); the same 200 for every address (fix round
//                            1: no answer here tells whether an address has an account). `admissionCode` is still
//                            accepted and ignored: it belongs to /verify now.
//   POST /:code/verify       { email, code } | { token }, each with admissionCode?  sign in with it (an account, or a
//                            new event guest). An address with no account that the event does not take is refused
//                            here, after its code is proved and before anything is spent or made: 403 in the
//                            event's words, details.admissionCode true when an admission code would let it in.
//   GET  /:code/entry        where the signed-in person stands                                           authenticate
//   POST /:code/enter        { displayName?, groupKeys?, admissionCode? }  give what is missing and enter  authenticate
//
// And the organisers' side, mounted at /api/sessions beside the event routes:
//   GET  /sessions/:id/call-link         { code, path, url }
//   POST /sessions/:id/call-link/rotate  a new code; the old link stops working at once
//
// A code that leads nowhere (malformed, unknown, a hidden draft, a deleted event) answers one identical 404 on every
// route here, and every such 404 counts toward callLinkMissLimiter (Review Focus 4; rateLimit.ts says how it is keyed).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { GROUP_LIMITS, isGroupKey, type ApiResponse, type UserRole } from '@rsn/shared';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import {
  admissionRedeemIpLimiter, admissionRedeemLimiter, callEntryLimiter, callLinkEmailLimiter, callLinkEmailTargetLimiter,
  callLinkManageLimiter, callLinkMissLimiter, callLinkReadLimiter, callLinkVerifyLimiter, signInCodeEmailLimiter,
} from '../middleware/rateLimit';
import * as callLink from '../services/session/call-link.service';
import * as callEntry from '../services/session/call-entry.service';

const router = Router();
export const sessionCallLinkRoutes = Router();

const CHECK_INPUT = 'Check what you entered and try again.';
const ENTRY_CODE_MESSAGE = 'Enter the 6-digit code from the email.';

const viewerOf = (req: Request): { userId: string; role: UserRole } | null =>
  req.user ? { userId: req.user.userId, role: req.user.role as UserRole } : null;

const emailSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(255),
  // Accepted and ignored since fix round 1 (an earlier client may send it): the admission code is checked at /verify.
  admissionCode: z.string().trim().max(40).optional(),
  clientUrl: z.string().url().max(2048).optional(),
});

const admissionCodeField = z.string().trim().min(1).max(40).optional();

const verifySchema = z.union([
  z.object({
    email: z.string().trim().email('Enter a valid email address.').max(255),
    // People paste the code with a space or a dash in the middle, as on the sign-in page.
    code: z.string().max(32).transform((c) => c.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{6}$/, ENTRY_CODE_MESSAGE)),
    admissionCode: admissionCodeField,
  }).strict(),
  z.object({ token: z.string().trim().min(1).max(200), admissionCode: admissionCodeField }).strict(),
]);

const enterSchema = z.object({
  displayName: z.string().max(200).optional(),
  groupKeys: z.array(z.string().refine(isGroupKey, "That group isn't one of this event's groups.")).max(GROUP_LIMITS.maxGroups).optional(),
  admissionCode: z.string().trim().min(1).max(40).optional(),
});

/**
 * The sign-in code's per-address bucket, only when an address was sent (an entry token carries none). Shared with sign-in
 * on purpose: the link adds no guessing budget against anyone's address. The per-network-address bucket is the link's own
 * (callLinkVerifyLimiter), so a room entering by code never uses up sign-in's.
 */
function entryCodeEmailBucket(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.body?.email === 'string' && req.body.email.length > 0) {
    signInCodeEmailLimiter(req, res, next);
    return;
  }
  next();
}

/**
 * An admission code typed while entering counts toward the same buckets as POST /sessions/:id/admission/redeem (per
 * person per event, and per network address): the event's id is put where those buckets read it. Only when a code
 * was sent and the link leads to an event; a wrong code is a 400 and counts, a right one does not.
 */
async function admissionTriesBucket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (typeof req.body?.admissionCode !== 'string' || req.body.admissionCode.length === 0) {
      next();
      return;
    }
    const event = await callLink.findCallEvent(req.params.code);
    if (!event) {
      next();
      return;
    }
    req.params.id = event.id;
    admissionRedeemIpLimiter(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      admissionRedeemLimiter(req, res, next);
    });
  } catch (err) {
    next(err);
  }
}

// ─── The signed-in person's events by link ───────────────────────────────────

router.get('/me/events', authenticate, callEntryLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await callEntry.listMyCallEvents(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});

// ─── The landing ─────────────────────────────────────────────────────────────

router.get('/:code', callLinkMissLimiter, callLinkReadLimiter, optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await callLink.getCallLanding(req.params.code, viewerOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ─── Identify: the code by email, then the code back ─────────────────────────

router.post('/:code/email', callLinkMissLimiter, callLinkEmailLimiter,
  validate(emailSchema, 'body', CHECK_INPUT), callLinkEmailTargetLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, clientUrl } = req.body as z.infer<typeof emailSchema>;
      const data = await callEntry.sendCallEntryCode(req.params.code, email, { clientUrl, origin: req.get('origin') });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:code/verify', callLinkMissLimiter, callLinkVerifyLimiter, validate(verifySchema, 'body', ENTRY_CODE_MESSAGE),
  entryCodeEmailBucket, admissionTriesBucket,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await callEntry.verifyCallEntry(req.params.code, req.body as z.infer<typeof verifySchema>);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ─── Signed in: where they stand, and entering ───────────────────────────────

router.get('/:code/entry', callLinkMissLimiter, authenticate, callEntryLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await callEntry.readCallEntry(req.params.code, req.user!.userId, req.user!.role as UserRole);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:code/enter', callLinkMissLimiter, authenticate, callEntryLimiter, validate(enterSchema, 'body', CHECK_INPUT),
  admissionTriesBucket,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await callEntry.enterCall(
        req.params.code, req.user!.userId, req.user!.role as UserRole, req.body as z.infer<typeof enterSchema>,
        { origin: req.get('origin') },
      );
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ─── The organisers' side (/api/sessions/:id/call-link) ──────────────────────

const eventId = uuidInPath('id', PATH_REFUSALS.event);
const actorOf = (req: Request) => ({ userId: req.user!.userId, role: req.user!.role as UserRole });

sessionCallLinkRoutes.get('/:id/call-link', authenticate, callLinkManageLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await callLink.getCallLinkForOrganiser(req.params.id, actorOf(req), { origin: req.get('origin') });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

sessionCallLinkRoutes.post('/:id/call-link/rotate', authenticate, callLinkManageLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callLink.rotateCallCode(req.params.id, actorOf(req));
      const data = await callLink.getCallLinkForOrganiser(req.params.id, actorOf(req), { origin: req.get('origin') });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
