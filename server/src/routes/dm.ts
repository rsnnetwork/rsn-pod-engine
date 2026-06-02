// ─── DM Routes ─────────────────────────────────────────────────────────────
//
// Phase C of chat-fix-and-dm-system plan (1 May 2026). 1:1 person-to-person
// messaging at the platform level. Authorization rules (encounter-gate +
// block-gate) live inside dmService — these routes are thin wrappers.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as dmService from '../services/dm/dm.service';
import { ApiResponse } from '@rsn/shared';

const router = Router();

// ─── Validation schemas ────────────────────────────────────────────────────

const sendBodySchema = z.object({
  toUserId: z.string().uuid(),
  content: z.string().min(1).max(4000),
});

const listQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

// Phase E — reaction body. Service layer enforces the allow-list, this
// schema only ensures the field shape is right.
const reactionBodySchema = z.object({
  emoji: z.string().min(1).max(16),
});

// ─── GET /dm/conversations — list my conversations ────────────────────────

router.get(
  '/conversations',
  authenticate,
  validate(listQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const result = await dmService.listConversations(req.user!.userId, { page, pageSize });
      const response: ApiResponse = {
        success: true,
        data: result.conversations,
        meta: {
          page: page || 1,
          pageSize: pageSize || 20,
          totalCount: result.total,
          totalPages: Math.ceil(result.total / (pageSize || 20)),
          hasNext: (page || 1) * (pageSize || 20) < result.total,
          hasPrev: (page || 1) > 1,
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /dm/conversations/:id/messages — list messages in a thread ───────

router.get(
  '/conversations/:id/messages',
  authenticate,
  validate(listQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const result = await dmService.listMessages(req.params.id, req.user!.userId, { page, pageSize });
      const response: ApiResponse = {
        success: true,
        data: result.messages,
        meta: {
          page: page || 1,
          pageSize: pageSize || 50,
          totalCount: result.total,
          totalPages: Math.ceil(result.total / (pageSize || 50)),
          hasNext: (page || 1) * (pageSize || 50) < result.total,
          hasPrev: (page || 1) > 1,
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /dm/messages — send a DM ─────────────────────────────────────────

router.post(
  '/messages',
  authenticate,
  validate(sendBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dmService.sendMessage(
        req.user!.userId,
        req.body.toUserId,
        req.body.content,
      );
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /dm/conversations/:id/read — mark conversation as read ──────────

router.post(
  '/conversations/:id/read',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dmService.markRead(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /dm/conversations/:id — soft-delete (for me only) ─────────────

router.delete(
  '/conversations/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await dmService.deleteConversation(req.params.id, req.user!.userId);
      const response: ApiResponse = { success: true, data: { message: 'Conversation deleted from your view' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /dm/can-message/:userId — gate for the profile Message button ────

router.get(
  '/can-message/:userId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dmService.canMessage(req.user!.userId, req.params.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /dm/unread-count — bell badge integer ────────────────────────────

router.get(
  '/unread-count',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await dmService.getUnreadCount(req.user!.userId);
      const response: ApiResponse = { success: true, data: { count } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /dm/messages/:id/reactions — add an emoji reaction (Phase E) ────
//
// Body: { emoji: 'heart' | 'clap' | 'thumbs_up' | 'laugh' | 'fire' | 'wow' }
// Idempotent: same user + same emoji + same message is a no-op.

router.post(
  '/messages/:id/reactions',
  authenticate,
  validate(reactionBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dmService.addReaction(
        req.params.id,
        req.user!.userId,
        req.body.emoji,
      );
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /dm/messages/:id/reactions/:emoji — remove a reaction ─────────

router.delete(
  '/messages/:id/reactions/:emoji',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await dmService.removeReaction(
        req.params.id,
        req.user!.userId,
        req.params.emoji,
      );
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
