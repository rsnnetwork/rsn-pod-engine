// ─── Entities (21 Oct 2026) ──────────────────────────────────────────────────
// Members create their company (or fund, university…) and link people to it with roles.
//
// GET    /entities?q=&limit=        { mine, others }
// POST   /entities                  { name, kind, role, title?, about?, location?, size?, website? }  201 { id, companyUpdated }
// GET    /entities/:id              { entity, people, myRole, canEdit }
// PATCH  /entities/:id              { name?, kind?, about?, location?, size?, website? }  { ok: true }   its admins, platform admins
// DELETE /entities/:id              archive  { ok: true }                                               its admins, platform admins
// POST   /entities/:id/members      { role, title? }  claim to be part of it (pending until an admin approves), or
//                                   ask to change your own role (applied at once for its admins and platform admins)
// DELETE /entities/:id/members/me   leave, or withdraw your claim  { left, archived }
//
// 30 Oct review (T15), its admins and platform admins:
// POST   /entities/:id/members/:userId/approve   a claim or a change   { ok: true }
// POST   /entities/:id/members/:userId/decline   a claim or a change   { ok: true }
// DELETE /entities/:id/members/:userId           remove a member       { ok: true }
// PUT    /entities/:id/logo | /banner            { image?, crop? }  { logoUrl } | { bannerUrl }
// DELETE /entities/:id/logo | /banner            { logoUrl: null } | { bannerUrl: null }
// GET    /entities/:id/logo/source | /banner/source   the picture the editor opens on
// Public (an <img> sends no token): GET /entities/:id/logo?v= and /banner?v=
//
// Shirley pilot S7 (RSN 15), its admins and platform admins:
// PUT    /entities/:id/services     { services: [{ category, description?, website? }] }  { services }   the whole list,
//                                   kept in the order sent (the editor sends the shared list's; admins do not reorder), at most
//                                   one per category; [] clears it. GET /entities/:id carries them.
//
// A person's entities (GET /users/:id/entities) are in routes/users.ts; an entity's links to circles are made from
// the circle (routes/circles.ts). The service decides who may do what; the routes check the shape of what was sent
// and tell the screens once a write is done.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  ApiResponse, ENTITY_KINDS, ENTITY_LIMITS, ENTITY_ROLES, ENTITY_SERVICE_CATEGORIES, UserRole, hasRoleAtLeast,
} from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  bannerReadLimiter, entityCreateLimiter, entityReadLimiter, entityWriteLimiter, pictureSourceLimiter,
} from '../middleware/rateLimit';
import { fanoutEntityChange, fanoutEntityCircles, fanoutProfileChange } from '../realtime/fanout';
import * as entities from '../services/entity/entity.service';
import * as entityPictures from '../services/entity/entity-pictures.service';
import * as entityServices from '../services/entity/entity-services.service';
import { blankToNull, characterCount, normaliseName, normaliseWebsite } from '../services/entity/entity-fields';
import { pictureBodySchema, type PictureBody } from './picture-body';

const router = Router();

/** Platform admins may edit and archive any entity. */
const isPlatformAdmin = (req: Request) => hasRoleAtLeast(req.user!.role, UserRole.ADMIN);

// ── What each route accepts ──────────────────────────────────────────────────

// Postgres reads an upper-case uuid as the same row, but the services compare ids as plain strings.
const entityParams = z.object({ id: z.string().uuid('Not an entity id').transform((s) => s.toLowerCase()) });
const memberParams = entityParams.extend({
  userId: z.string().uuid('Not a member id').transform((s) => s.toLowerCase()),
});

const listQuery = z.object({
  q: z.string().max(ENTITY_LIMITS.searchMax).optional(),
  limit: z.coerce.number().int().min(1).optional()
    .transform((n) => (n === undefined ? undefined : Math.min(n, ENTITY_LIMITS.othersMax))),
});

// Counted in characters, as the database counts them (see characterCount): one emoji is one character.
const name = z.string({ required_error: 'Give the entity a name.', invalid_type_error: 'Give the entity a name.' })
  .transform(normaliseName)
  .pipe(z.string()
    .refine((s) => characterCount(s) >= ENTITY_LIMITS.nameMin, `Give the entity a name of at least ${ENTITY_LIMITS.nameMin} characters.`)
    .refine((s) => characterCount(s) <= ENTITY_LIMITS.nameMax, `Keep the name to ${ENTITY_LIMITS.nameMax} characters.`));
const kind = z.enum(ENTITY_KINDS, { errorMap: () => ({ message: 'Choose what kind of entity this is.' }) });
const role = z.enum(ENTITY_ROLES, { errorMap: () => ({ message: 'Choose how you are linked to it.' }) });

/** Optional text: trimmed, at most `max` characters, and blank (or null) is stored as null. */
const optionalText = (max: number, what: string) =>
  z.string().trim().max(max, `Keep ${what} to ${max} characters.`).nullable().optional()
    .transform((s) => (s === undefined ? undefined : blankToNull(s)));

// Rendered as a link, so it is always http or https (see normaliseWebsite). Blank clears it.
const website = z.string().max(ENTITY_LIMITS.websiteMax, `Keep the website to ${ENTITY_LIMITS.websiteMax} characters.`)
  .nullable().optional()
  .transform((s, ctx) => {
    if (s === undefined) return undefined;
    const typed = blankToNull(s);
    if (typed === null) return null;
    const address = normaliseWebsite(typed);
    if (address === null || address.length > ENTITY_LIMITS.websiteMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a web address, such as acme.com.' });
      return z.NEVER;
    }
    return address;
  });

const details = {
  about: optionalText(ENTITY_LIMITS.aboutMax, 'the description'),
  location: optionalText(ENTITY_LIMITS.locationMax, 'the location'),
  size: optionalText(ENTITY_LIMITS.sizeMax, 'the size'),
  website,
};

const createBody = z.object({
  name, kind, role, title: optionalText(ENTITY_LIMITS.titleMax, 'the title'), ...details,
});
const updateBody = z.object({ name: name.optional(), kind: kind.optional(), ...details })
  .refine((changes) => Object.values(changes).some((v) => v !== undefined), { message: 'Nothing to change.' });
const membershipBody = z.object({ role, title: optionalText(ENTITY_LIMITS.titleMax, 'the title') });

// S7: one service. The description is counted in characters (an emoji is one), as VARCHAR(280) counts it; blank is
// null. The website is https only (normaliseServiceWebsite); javascript: and every other scheme are refused.
const service = z.object({
  category: z.enum(ENTITY_SERVICE_CATEGORIES, { errorMap: () => ({ message: 'Choose a service from the list.' }) }),
  description: z.string().max(ENTITY_LIMITS.serviceDescriptionMax * 2, `Keep each description to ${ENTITY_LIMITS.serviceDescriptionMax} characters.`).nullable().optional()
    .transform((s) => blankToNull(s ?? null))
    .refine((s) => s === null || characterCount(s) <= ENTITY_LIMITS.serviceDescriptionMax,
      `Keep each description to ${ENTITY_LIMITS.serviceDescriptionMax} characters.`),
  website: z.string().max(ENTITY_LIMITS.websiteMax, entityServices.SERVICE_WEBSITE_REFUSED).nullable().optional()
    .transform((s, ctx) => {
      const typed = blankToNull(s ?? null);
      if (typed === null) return null;
      const address = entityServices.normaliseServiceWebsite(typed);
      if (address === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: entityServices.SERVICE_WEBSITE_REFUSED });
        return z.NEVER;
      }
      return address;
    }),
}).strict();
const servicesBody = z.object({
  services: z.array(service, { required_error: 'Send the list of services.', invalid_type_error: 'Send the list of services.' })
    .max(ENTITY_LIMITS.servicesMax, `List at most ${ENTITY_LIMITS.servicesMax} services.`)
    .refine((list) => new Set(list.map((s) => s.category)).size === list.length, 'Each service can be listed once.'),
}).strict();

// validate() has already replaced req.body / req.query with the parsed value, but Express types them
// loosely. A field that was not sent is not in the parsed value, so an edit changes only what it names.
type ListQuery = z.infer<typeof listQuery>;
type CreateBody = z.infer<typeof createBody>;
type UpdateBody = z.infer<typeof updateBody>;
type MembershipBody = z.infer<typeof membershipBody>;
type ServicesBody = z.infer<typeof servicesBody>;

// ── Reads (they change nothing, so they emit nothing) ───────────────────────

router.get('/', authenticate, entityReadLimiter, validate(listQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, limit } = req.query as unknown as ListQuery;
      const data = await entities.listEntities(req.user!.userId, { q, limit });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id', authenticate, entityReadLimiter, validate(entityParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [page, services] = await Promise.all([
        entities.getEntity(req.user!.userId, req.params.id, isPlatformAdmin(req)),
        // S7: what it offers. getEntity has decided the entity is live (404 otherwise), so nothing of an archived one is sent.
        entityServices.listEntityServices(req.params.id),
      ]);
      res.json({ success: true, data: { ...page, services } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ── Writes. Each tells the screens once it has happened (fanout.ts says who) ─

router.post('/', authenticate, entityCreateLimiter, validate(createBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const data = await entities.createEntity(me, req.body as CreateBody);
      void fanoutEntityChange(data.id, me, [me]);
      if (data.companyUpdated) void fanoutProfileChange(me);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.patch('/:id', authenticate, entityWriteLimiter, validate(entityParams, 'params'), validate(updateBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      await entities.updateEntity(me, req.params.id, req.body as UpdateBody, isPlatformAdmin(req));
      void fanoutEntityChange(req.params.id, me);
      void fanoutEntityCircles(req.params.id); // its name or kind on the circle pages that list it
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id', authenticate, entityWriteLimiter, validate(entityParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      await entities.archiveEntity(me, req.params.id, isPlatformAdmin(req));
      void fanoutEntityChange(req.params.id, me);
      void fanoutEntityCircles(req.params.id); // it leaves the circle pages that list it
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/members', authenticate, entityWriteLimiter, validate(entityParams, 'params'), validate(membershipBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const data = await entities.setMyMembership(me, req.params.id, req.body as MembershipBody, isPlatformAdmin(req));
      void fanoutEntityChange(req.params.id, me, [me]);
      if (data.companyUpdated) void fanoutProfileChange(me);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/members/me', authenticate, entityWriteLimiter, validate(entityParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const data = await entities.leaveEntity(me, req.params.id);
      // Someone who was not linked to it changed nothing, so no screen needs telling.
      if (data.left) void fanoutEntityChange(req.params.id, me, [me]);
      // The last person out archives it, and it leaves the circle pages that list it.
      if (data.archived) void fanoutEntityCircles(req.params.id);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// S7 (RSN 15): what it offers, set by its admins. The services show on its page, which follows entity:<id>.
router.put('/:id/services', authenticate, entityWriteLimiter, validate(entityParams, 'params'),
  validate(servicesBody, 'body', 'Check the services and try again.'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const { services } = req.body as ServicesBody;
      const saved = await entityServices.setEntityServices(me, req.params.id, services, isPlatformAdmin(req));
      void fanoutEntityChange(req.params.id, me);
      res.json({ success: true, data: { services: saved } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ── The admins' answers (30 Oct review, 7.2; L23). Declared after /members/me, which they never match ─────────

type MemberParams = z.infer<typeof memberParams>;

router.post('/:id/members/:userId/approve', authenticate, entityWriteLimiter, validate(memberParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const { id, userId } = req.params as unknown as MemberParams;
      const { companyUpdated } = await entities.approveMember(me, id, userId, isPlatformAdmin(req));
      void fanoutEntityChange(id, me, [userId]);
      if (companyUpdated) void fanoutProfileChange(userId);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/members/:userId/decline', authenticate, entityWriteLimiter, validate(memberParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const { id, userId } = req.params as unknown as MemberParams;
      await entities.declineMember(me, id, userId, isPlatformAdmin(req));
      void fanoutEntityChange(id, me, [userId]);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/members/:userId', authenticate, entityWriteLimiter, validate(memberParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const { id, userId } = req.params as unknown as MemberParams;
      await entities.removeMember(me, id, userId, isPlatformAdmin(req));
      void fanoutEntityChange(id, me, [userId]);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// ── The logo and the banner (30 Oct review, 7.1; L1) ──────────────────────────────────────────────────────────

const PICTURES = [
  { kind: 'logo', field: 'logoUrl' },
  { kind: 'banner', field: 'bannerUrl' },
] as const;

for (const { kind, field } of PICTURES) {
  const body = pictureBodySchema({ choose: `Choose a picture for the ${kind}.`, tooBig: `The ${kind} must be 3 MB or smaller.` });

  // Its admins and platform admins: a new picture with where it was placed, or a new place for the kept one.
  router.put(`/:id/${kind}`, authenticate, entityWriteLimiter, validate(entityParams, 'params'), validate(body),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const me = req.user!.userId;
        const { image, crop } = req.body as PictureBody;
        const { url } = await entityPictures.saveEntityPicture(me, req.params.id, kind, { image, crop }, isPlatformAdmin(req));
        void fanoutEntityChange(req.params.id, me);
        void fanoutEntityCircles(req.params.id); // the logo on the circle pages that list it
        res.json({ success: true, data: { [field]: url } } satisfies ApiResponse);
      } catch (err) {
        next(err);
      }
    });

  router.delete(`/:id/${kind}`, authenticate, entityWriteLimiter, validate(entityParams, 'params'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const me = req.user!.userId;
        await entityPictures.removeEntityPicture(me, req.params.id, kind, isPlatformAdmin(req));
        void fanoutEntityChange(req.params.id, me);
        void fanoutEntityCircles(req.params.id);
        res.json({ success: true, data: { [field]: null } } satisfies ApiResponse);
      } catch (err) {
        next(err);
      }
    });

  // What the editor opens on, for the people who may change it.
  router.get(`/:id/${kind}/source`, authenticate, pictureSourceLimiter, validate(entityParams, 'params'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const data = await entityPictures.getEntityPictureSource(req.user!.userId, req.params.id, kind, isPlatformAdmin(req));
        res.json({ success: true, data } satisfies ApiResponse);
      } catch (err) {
        next(err);
      }
    });

  // Public, as a member's banner is: an <img> sends no token. The address carries ?v=<when it changed>, so a day-long
  // cache never shows an old picture after a new one. 404 with nothing in it for no picture or an archived entity.
  router.get(`/:id/${kind}`, bannerReadLimiter, validate(entityParams, 'params'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const picture = await entityPictures.getEntityPictureBlob(req.params.id, kind);
        if (!picture) {
          res.status(404).end();
          return;
        }
        res.setHeader('Content-Type', picture.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        // These bytes come from a member, so a browser must never read them as anything but the picture type they were cut as.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(picture.blob);
      } catch (err) {
        next(err);
      }
    });
}

export default router;
