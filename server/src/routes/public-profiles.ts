// ─── A member's public profile link (Shirley pilot S6, 11 Nov 2026; plan decision D5) ───────────────────────────────
//
// Mounted at /api/public/profiles (no sign-in needed; a signed-in reader is read so a block stands):
//   GET    /:token        the public card the link shows (PublicProfileCard)            optionalAuth
//                         Every link that opens nothing (malformed, unknown, revoked, replaced, a closed or guest
//                         account, a member hidden from search, a block either way) answers one identical 404, and each
//                         such 404 counts toward publicProfileMissLimiter. Never cached, never indexed.
//
// And the owner's side, mounted at /api/users/me/public-link (members only: none is in GUEST_ROUTES, so an event guest
// gets 403 GUEST_MEMBERSHIP_REQUIRED from `authenticate`):
//   GET    /              the member's link, or none (PublicProfileLinkState)
//   POST   /              make the link, or keep the one they have (a second press answers the same link)
//   POST   /regenerate    a new link in place of the old one, which stops at once (409 when there is none)
//   DELETE /              turn the link off
// Each write tells the member's other tabs and devices (user:<id>) and is written to the audit log (never the token).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ApiResponse } from '@rsn/shared';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { recordAudit } from '../middleware/audit';
import {
  peopleReadLimiter, publicLinkWriteLimiter, publicProfileMissLimiter, publicProfileReadLimiter,
} from '../middleware/rateLimit';
import { fanoutUserEntity } from '../realtime/fanout';
import * as publicLink from '../services/user/public-link.service';

const router = Router();
export const publicLinkRoutes = Router();

// Any text is taken here and judged by the service (PUBLIC_TOKEN_SHAPE), so a malformed token, however long, answers
// the same 404 as an unknown one. Express bounds a path long before it reaches here.
const tokenParams = z.object({ token: z.string() });

router.get('/:token', publicProfileMissLimiter, publicProfileReadLimiter, validate(tokenParams, 'params'), optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // A page anyone may hold, about a person: kept out of search engines whatever the page itself says.
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const data = await publicLink.getPublicProfile(req.params.token, req.user?.userId ?? null);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ─── The owner's side ────────────────────────────────────────────────────────

publicLinkRoutes.get('/', authenticate, peopleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await publicLink.getMyPublicLink(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});

type LinkWrite = (userId: string) => Promise<unknown>;

/** A write to the member's own link: done, answered, then told to their other screens and written to the audit log. */
const linkWrite = (write: LinkWrite, action: string) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const data = await write(userId);
      res.json({ success: true, data } satisfies ApiResponse);
      fanoutUserEntity(userId).catch(() => {});
      void recordAudit({ actorId: userId, action, entityType: 'user', entityId: userId, ipAddress: req.ip });
    } catch (err) {
      next(err);
    }
  };

publicLinkRoutes.post('/', authenticate, publicLinkWriteLimiter,
  linkWrite(publicLink.createPublicLink, 'user.public_link_created'));
publicLinkRoutes.post('/regenerate', authenticate, publicLinkWriteLimiter,
  linkWrite(publicLink.regeneratePublicLink, 'user.public_link_regenerated'));
publicLinkRoutes.delete('/', authenticate, publicLinkWriteLimiter,
  linkWrite(publicLink.revokePublicLink, 'user.public_link_revoked'));

export default router;
