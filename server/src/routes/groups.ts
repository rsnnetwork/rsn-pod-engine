// ─── Group Chat Routes ─────────────────────────────────────────────────────
//
// Phase I of chat-fix-and-dm-system plan (1 May 2026). Custom groups + pod
// chats. Pod chats are auto-provisioned via pod.service hooks, not via
// these routes.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as groupService from '../services/dm/group.service';
import { fanoutGroupEntities } from '../realtime/fanout';
import { ApiResponse } from '@rsn/shared';

const router = Router();

const createGroupSchema = z.object({
  name: z.string().min(1).max(200),
  memberIds: z.array(z.string().uuid()).min(1).max(50),
});

const sendGroupMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

// POST /groups — create a custom group
router.post(
  '/',
  authenticate,
  validate(createGroupSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.createCustomGroup(
        req.user!.userId, req.body.name, req.body.memberIds,
      );
      // Phase May-19 realtime — fanout to every member's personal
      // room so the new group appears in their inbox without a refresh.
      fanoutGroupEntities(result.id).catch(() => {});
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /groups — list groups I'm a member of
router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.listMyGroups(req.user!.userId);
      const response: ApiResponse = { success: true, data: result };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups/:id/messages — send a message
router.post(
  '/:id/messages',
  authenticate,
  validate(sendGroupMessageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.sendGroupMessage(
        req.params.id, req.user!.userId, req.body.content,
      );
      // Phase May-19 realtime — fanout to every group member so their
      // open thread / inbox surfaces refetch immediately. The group
      // entity tag invalidates the dm-groups / dm-messages queries.
      fanoutGroupEntities(req.params.id).catch(() => {});
      const response: ApiResponse = { success: true, data: result };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /groups/:id/messages — list messages
router.get(
  '/:id/messages',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;
      const result = await groupService.listGroupMessages(req.params.id, req.user!.userId, { page, pageSize });
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

export default router;
