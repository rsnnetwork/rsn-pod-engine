// ─── The matching board's draft (10 Nov 2026 spec, Part 2 Task 8) ──────────────────────────────────────────
//
// GET  /sessions/:id/schedule            ScheduleBoard: rounds, rooms, seats, baskets, verdicts, the revision
// POST /sessions/:id/schedule/generate   { expectedRevision, rounds: number[] | 'all' } → BoardOpResult
// POST /sessions/:id/schedule/ops        { expectedRevision, op: BoardOp } → BoardOpResult
// GET  /sessions/:id/schedule/publish-preview   PublishPreview: what blocks publishing, what it keeps, who it changes
// POST /sessions/:id/schedule/publish   { expectedRevision, note? } → PublishResult (Part 2 Task 9)
// GET  /sessions/:id/schedule/versions  ScheduleVersionSummary[]: the published versions, latest first
// GET  /sessions/:id/schedule/mine      MySchedule | null: the signed-in participant's own published meetings
//
// Mounted at /api/sessions beside the event routes. Organisers only (canActAsHost, checked by the service, which
// also refuses a write made against an older board with 409 SCHEDULE_CHANGED and the board now, audits every
// change, and tells the host and co-hosts on session:<id>:schedule), except /mine, which anyone with a place in the
// event reads (an event guest too: it is on the guest allowlist). The live event reads only published versions
// (schedule-live.service.ts); a publish while live rewrites the changed rooms of the rounds not yet started.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type {
  ApiResponse, BoardOp, BoardOpResult, MySchedule, PublishPreview, PublishResult, ScheduleBoard, ScheduleVersionSummary,
} from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { scheduleReadLimiter, scheduleWriteLimiter } from '../middleware/rateLimit';
import { applyBoardOp, generateBoard, getBoard } from '../services/schedule/schedule-board.service';
import {
  getMySchedule, listScheduleVersions, previewPublish, publishSchedule,
} from '../services/schedule/schedule-publish.service';

const router = Router();

const uuid = (message: string) => z.string().uuid(message).transform((s) => s.toLowerCase());
const eventParams = z.object({ id: uuid('Not an event id') });

const MAX_ROUND = 100;
const round = z.number().int().min(1).max(MAX_ROUND);
const room = z.number().int().min(1).max(1000);
const person = uuid('Not a member id');
const rounds = z.union([z.literal('all'), z.array(round).min(1).max(MAX_ROUND)]);
const expectedRevision = z.number().int().min(0);

/** An override of the round's group rule, and the organiser's reason for it. */
const overrideFields = {
  override: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
};

export const boardOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), round, userId: person, toRoom: room, ...overrideFields }),
  z.object({ kind: z.literal('swap'), round, userId: person, withUserId: person, ...overrideFields }),
  z.object({ kind: z.literal('unassign'), round, userId: person, ...overrideFields }),
  z.object({ kind: z.literal('lock_room'), round, room, ...overrideFields }),
  z.object({ kind: z.literal('unlock_room'), round, room, ...overrideFields }),
  z.object({ kind: z.literal('lock_slot'), round, userId: person, ...overrideFields }),
  z.object({ kind: z.literal('unlock_slot'), round, userId: person, ...overrideFields }),
  z.object({ kind: z.literal('redistribute'), rounds, ...overrideFields }),
  z.object({ kind: z.literal('mark_late'), userId: person, fromRound: round, ...overrideFields }),
  z.object({ kind: z.literal('mark_no_show'), userId: person, ...overrideFields }),
  z.object({ kind: z.literal('clear_absence'), userId: person, ...overrideFields }),
]).refine((op) => op.kind !== 'swap' || op.userId !== op.withUserId, { message: 'Choose two different people to swap.' });

const generateBody = z.object({ expectedRevision, rounds });
const opsBody = z.object({ expectedRevision, op: boardOpSchema });
const publishBody = z.object({ expectedRevision, note: z.string().trim().max(500).optional() });

const actorOf = (req: Request) => ({ userId: req.user!.userId, role: req.user!.role });

// A read changes nothing, so it tells no screens.
router.get('/:id/schedule', authenticate, scheduleReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getBoard(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse<ScheduleBoard>);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/schedule/generate', authenticate, scheduleWriteLimiter, validate(eventParams, 'params'), validate(generateBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof generateBody>;
      const data = await generateBoard(req.params.id, actorOf(req), body.expectedRevision, body.rounds);
      res.json({ success: true, data } satisfies ApiResponse<BoardOpResult>);
    } catch (err) {
      next(err);
    }
  });

router.post('/:id/schedule/ops', authenticate, scheduleWriteLimiter, validate(eventParams, 'params'), validate(opsBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof opsBody>;
      const data = await applyBoardOp(req.params.id, actorOf(req), body.expectedRevision, body.op as BoardOp);
      res.json({ success: true, data } satisfies ApiResponse<BoardOpResult>);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id/schedule/publish-preview', authenticate, scheduleReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await previewPublish(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse<PublishPreview>);
    } catch (err) {
      next(err);
    }
  });

// Refused with 409 SCHEDULE_HAS_CONFLICTS (details.blocking) while anything blocks, 409 SCHEDULE_CHANGED (details.board)
// when the board changed since the organiser's read. The service tells every screen and rings the impacted.
router.post('/:id/schedule/publish', authenticate, scheduleWriteLimiter, validate(eventParams, 'params'), validate(publishBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof publishBody>;
      const data = await publishSchedule(req.params.id, actorOf(req), body.expectedRevision, { note: body.note });
      res.json({ success: true, data } satisfies ApiResponse<PublishResult>);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id/schedule/versions', authenticate, scheduleReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await listScheduleVersions(req.params.id, actorOf(req));
      res.json({ success: true, data } satisfies ApiResponse<ScheduleVersionSummary[]>);
    } catch (err) {
      next(err);
    }
  });

router.get('/:id/schedule/mine', authenticate, scheduleReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getMySchedule(req.params.id, req.user!.userId);
      res.json({ success: true, data } satisfies ApiResponse<MySchedule | null>);
    } catch (err) {
      next(err);
    }
  });

export default router;
