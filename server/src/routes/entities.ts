// ─── Entities (21 Oct 2026) ──────────────────────────────────────────────────
// Members create their company (or fund, university…) and link people to it with roles.
//
// GET    /entities?q=&limit=        { mine, others }
// POST   /entities                  { name, kind, role, title?, about?, location?, size?, website? }  201 { id, companyUpdated }
// GET    /entities/:id              { entity, people, myRole, canEdit }
// PATCH  /entities/:id              { name?, kind?, about?, location?, size?, website? }  { ok: true }   its admins, platform admins
// DELETE /entities/:id              archive  { ok: true }                                               its admins, platform admins
// POST   /entities/:id/members      { role, title? }  join, or change your own role
// DELETE /entities/:id/members/me   leave  { left, archived }
//
// A person's entities (GET /users/:id/entities) are in routes/users.ts. The service decides who may
// do what; the routes check the shape of what was sent and tell the screens once a write is done.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, ENTITY_KINDS, ENTITY_LIMITS, ENTITY_ROLES, UserRole, hasRoleAtLeast } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { entityCreateLimiter, entityReadLimiter, entityWriteLimiter } from '../middleware/rateLimit';
import { fanoutEntityChange, fanoutProfileChange } from '../realtime/fanout';
import * as entities from '../services/entity/entity.service';
import { blankToNull, normaliseName, normaliseWebsite } from '../services/entity/entity-fields';

const router = Router();

/** Platform admins may edit and archive any entity. */
const isPlatformAdmin = (req: Request) => hasRoleAtLeast(req.user!.role, UserRole.ADMIN);

// ── What each route accepts ──────────────────────────────────────────────────

// Postgres reads an upper-case uuid as the same row, but the services compare ids as plain strings.
const entityParams = z.object({ id: z.string().uuid('Not an entity id').transform((s) => s.toLowerCase()) });

const listQuery = z.object({
  q: z.string().max(ENTITY_LIMITS.searchMax).optional(),
  limit: z.coerce.number().int().min(1).optional()
    .transform((n) => (n === undefined ? undefined : Math.min(n, ENTITY_LIMITS.othersMax))),
});

const name = z.string({ required_error: 'Give the entity a name.', invalid_type_error: 'Give the entity a name.' })
  .transform(normaliseName)
  .pipe(z.string()
    .min(ENTITY_LIMITS.nameMin, `Give the entity a name of at least ${ENTITY_LIMITS.nameMin} characters.`)
    .max(ENTITY_LIMITS.nameMax, `Keep the name to ${ENTITY_LIMITS.nameMax} characters.`));
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

// validate() has already replaced req.body / req.query with the parsed value, but Express types them
// loosely. A field that was not sent is not in the parsed value, so an edit changes only what it names.
type ListQuery = z.infer<typeof listQuery>;
type CreateBody = z.infer<typeof createBody>;
type UpdateBody = z.infer<typeof updateBody>;
type MembershipBody = z.infer<typeof membershipBody>;

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
      const data = await entities.getEntity(req.user!.userId, req.params.id, isPlatformAdmin(req));
      res.json({ success: true, data } satisfies ApiResponse);
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
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/members', authenticate, entityWriteLimiter, validate(entityParams, 'params'), validate(membershipBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const data = await entities.setMyMembership(me, req.params.id, req.body as MembershipBody);
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
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
