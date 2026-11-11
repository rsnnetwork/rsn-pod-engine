// ─── An event's image (10 Nov 2026 spec, Part 3 Task 1) ───────────────────────────────────────────────────────────
// Mounted at /api/sessions beside routes/sessions.ts.
//
// PUT    /sessions/:id/image          { image?, crop? }  { imageUrl }        the event's host, platform admins
// DELETE /sessions/:id/image          { imageUrl: null }                     the same people
// GET    /sessions/:id/image/source   the picture the editor opens on        the same people
// Public (an <img> sends no token): GET /sessions/:id/image?v=
//
// The service decides who may change it (event-image.service.ts); the routes check the shape of what was sent and
// tell the event's people and their lists once a write is done. Nothing here is guest-reachable.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { bannerWriteLimiter, eventImageReadLimiter, pictureSourceLimiter } from '../middleware/rateLimit';
import { fanoutSessionEntities, fanoutSessionListEntities } from '../realtime/fanout';
import * as eventImage from '../services/session/event-image.service';
import { pictureBodySchema, type PictureBody } from './picture-body';

const router = Router();

const isPlatformAdmin = (req: Request) => hasRoleAtLeast(req.user!.role, UserRole.ADMIN);
const eventId = uuidInPath('id', PATH_REFUSALS.event);
const body = pictureBodySchema({ choose: 'Choose a picture for the event image.', tooBig: 'The event image must be 3 MB or smaller.' });

/** The event page, its people and every list that shows the event read the new address. */
function tellEveryone(podId: string | null, sessionId: string): void {
  fanoutSessionEntities(podId, sessionId).catch(() => {});
  fanoutSessionListEntities(podId, sessionId).catch(() => {});
}

// A new picture with where it was placed, or a new place for the kept one.
router.put('/:id/image', authenticate, bannerWriteLimiter, eventId, validate(body),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { image, crop } = req.body as PictureBody;
      const { imageUrl, podId } = await eventImage.saveEventImage(req.user!.userId, req.params.id, { image, crop }, isPlatformAdmin(req));
      tellEveryone(podId, req.params.id);
      res.json({ success: true, data: { imageUrl } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/image', authenticate, bannerWriteLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { podId } = await eventImage.removeEventImage(req.user!.userId, req.params.id, isPlatformAdmin(req));
      tellEveryone(podId, req.params.id);
      res.json({ success: true, data: { imageUrl: null } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// What the editor opens on, for the people who may change it.
router.get('/:id/image/source', authenticate, pictureSourceLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await eventImage.getEventImageSource(req.user!.userId, req.params.id, isPlatformAdmin(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

const isUuid = (value: string) => z.string().uuid().safeParse(value).success;

// Public, as an entity's pictures are. The address carries ?v=<when it changed>, so a day-long cache never shows an old
// image after a new one. 404 with nothing in it for no image, an event that is not there, or an id that names nothing.
router.get('/:id/image', eventImageReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const image = isUuid(req.params.id) ? await eventImage.getEventImageBlob(req.params.id.toLowerCase()) : null;
      if (!image) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', image.mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      // These bytes come from a member, so a browser must never read them as anything but the picture type they were cut as.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(image.bytes);
    } catch (err) {
      next(err);
    }
  });

export default router;
