// ─── Admission per event (Part 2, Task 4, 10 Nov 2026) ───────────────────────
// Who gets a place on an event, and the lists that decide it. Mounted at /api/sessions beside the event routes.
//
// GET    /sessions/:id/admission                      the mode, what decides a place, the counts      (organisers)
// PUT    /sessions/:id/admission                      { mode: 'open' | 'approval' | 'restricted' | null }
// GET    /sessions/:id/admission/emails?q&cursor&limit  the allowed emails, by address, a page at a time
// POST   /sessions/:id/admission/emails               { emails?: string[], csv?: string, groupKey?, source }  (300 KB at most)
// DELETE /sessions/:id/admission/emails/:entryId      take an address off the list
// GET    /sessions/:id/admission/codes                the codes, last four symbols only
// POST   /sessions/:id/admission/codes                { count: 1..500, label?, groupKey?, expiresAt? } → the codes, once
// DELETE /sessions/:id/admission/codes/:codeId        revoke a code
// POST   /sessions/:id/admission/redeem               { code }  any signed-in person
//
// The service decides who may do each; the routes check the shape of what was sent. Every write tells the screens
// from the service (session:<id>:admission and the event's own fan-out), after its transaction has committed.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ADMISSION_MODES, ErrorCodes, type AdmissionMode, type ApiResponse, type UserRole } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errors';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import {
  admissionReadLimiter, admissionRedeemIpLimiter, admissionRedeemLimiter, admissionWriteLimiter,
} from '../middleware/rateLimit';
import * as admission from '../services/session/event-admission.service';

const router = Router();

/** The largest body the emails route reads (the app-wide JSON limit is far larger). */
export const ADMISSION_BODY_MAX_BYTES = 300 * 1024;
const BODY_TOO_BIG = 'That list is too big. Import at most 300 KB at a time.';
const CHECK_INPUT = 'Check what you entered and try again.';

/**
 * 413 for an emails body over 300 KB, by its declared length, or (sent without one) by the size of what was read.
 * express.json has already read it under the app's own limit; this keeps the import's own bound.
 */
export function admissionBodyLimit(req: Request, _res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length']);
  const size = Number.isFinite(declared) && declared > 0 ? declared : Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
  if (size > ADMISSION_BODY_MAX_BYTES) {
    next(new AppError(413, ErrorCodes.PAYLOAD_TOO_LARGE, BODY_TOO_BIG));
    return;
  }
  next();
}

const actorOf = (req: Request): admission.Actor => ({ userId: req.user!.userId, role: req.user!.role as UserRole });

const eventId = uuidInPath('id', PATH_REFUSALS.event);
const entryId = uuidInPath('entryId', "We couldn't find that address on the list.");
const codeId = uuidInPath('codeId', "We couldn't find that admission code.");

/** A group key as event groups name them (Task 5): lower-case letters, digits and '_', 32 at most. */
const groupKeySchema = z.string().trim().regex(/^[a-z0-9_]{1,32}$/, 'That is not a group of this event.').nullable().optional();

const modeSchema = z.object({
  mode: z.enum(ADMISSION_MODES as [AdmissionMode, ...AdmissionMode[]]).nullable(),
}).strict();

const emailsSchema = z.object({
  emails: z.array(z.string().max(320)).max(10_000, admission.ADMISSION_TOO_MANY).optional(),
  csv: z.string().max(ADMISSION_BODY_MAX_BYTES).optional(),
  groupKey: groupKeySchema,
  source: z.enum(['paste', 'csv', 'organiser']),
}).strict().refine((b) => b.emails !== undefined || b.csv !== undefined, {
  message: 'Add at least one email address.', path: ['emails'],
});

const entryPageSchema = z.object({
  q: z.string().trim().max(255).optional(),
  cursor: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const codesSchema = z.object({
  count: z.number().int().min(1, 'Make between 1 and 500 codes at a time.').max(admission.ADMISSION_CODES_MAX, 'Make between 1 and 500 codes at a time.'),
  label: z.string().trim().max(80).optional(),
  groupKey: groupKeySchema,
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const redeemSchema = z.object({ code: z.string().trim().min(1, admission.ADMISSION_CODE_INVALID_SENTENCE).max(40, admission.ADMISSION_CODE_INVALID_SENTENCE) }).strict();

router.get('/:id/admission', authenticate, admissionReadLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await admission.getAdmissionOverview(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.put('/:id/admission', authenticate, admissionWriteLimiter, eventId, validate(modeSchema, 'body', CHECK_INPUT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await admission.setAdmissionMode(req.params.id, actorOf(req), req.body.mode as AdmissionMode | null);
      const data = await admission.getAdmissionOverview(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id/admission/emails', authenticate, admissionReadLimiter, eventId, validate(entryPageSchema, 'query', CHECK_INPUT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, cursor, limit } = req.query as unknown as z.infer<typeof entryPageSchema>;
      const data = await admission.listAdmissionEntries(req.params.id, actorOf(req), { q, cursor, limit });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/admission/emails', authenticate, admissionWriteLimiter, eventId, admissionBodyLimit,
  validate(emailsSchema, 'body', CHECK_INPUT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof emailsSchema>;
      const data = await admission.addAdmissionEmails(req.params.id, actorOf(req), {
        emails: body.emails, csv: body.csv, groupKey: body.groupKey ?? null, source: body.source,
      });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/admission/emails/:entryId', authenticate, admissionWriteLimiter, eventId, entryId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await admission.revokeAdmissionEmail(req.params.id, actorOf(req), req.params.entryId);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id/admission/codes', authenticate, admissionReadLimiter, eventId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await admission.listAdmissionCodes(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/admission/codes', authenticate, admissionWriteLimiter, eventId, validate(codesSchema, 'body', CHECK_INPUT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof codesSchema>;
      const data = await admission.generateAdmissionCodes(req.params.id, actorOf(req), {
        count: body.count, label: body.label, groupKey: body.groupKey ?? null, expiresAt: body.expiresAt ?? null,
      });
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

router.delete('/:id/admission/codes/:codeId', authenticate, admissionWriteLimiter, eventId, codeId,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await admission.revokeAdmissionCode(req.params.id, actorOf(req), req.params.codeId);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

// Any signed-in person. A wrong try counts against both buckets (rateLimit.ts); a right one never does.
router.post('/:id/admission/redeem', authenticate, eventId, admissionRedeemIpLimiter, admissionRedeemLimiter,
  validate(redeemSchema, 'body', admission.ADMISSION_CODE_INVALID_SENTENCE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupKey } = await admission.redeemAdmissionCode(req.params.id, req.user!.userId, req.body.code as string);
      res.json({ success: true, data: { ok: true, groupKey } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
