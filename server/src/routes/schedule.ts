// ─── The matching board's draft (10 Nov 2026 spec, Part 2 Task 8) ──────────────────────────────────────────
//
// GET  /sessions/:id/schedule            ScheduleBoard: rounds, rooms, seats, baskets, verdicts, the revision
// POST /sessions/:id/schedule/generate   { expectedRevision, rounds: number[] | 'all' } → BoardOpResult
// POST /sessions/:id/schedule/ops        { expectedRevision, op: BoardOp } → BoardOpResult
//
// Mounted at /api/sessions beside the event routes. Organisers only (canActAsHost, checked by the service, which
// also refuses a write made against an older board with 409 SCHEDULE_CHANGED and the board now, audits every
// change, and tells the host and co-hosts on session:<id>:schedule). Nothing here is read by the live event.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ApiResponse, BoardOp, BoardOpResult, ScheduleBoard } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { scheduleReadLimiter, scheduleWriteLimiter } from '../middleware/rateLimit';
import { applyBoardOp, generateBoard, getBoard } from '../services/schedule/schedule-board.service';

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

export default router;
