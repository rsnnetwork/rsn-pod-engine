// ─── Group Chat Routes ─────────────────────────────────────────────────────
//
// Phase I of chat-fix-and-dm-system plan (1 May 2026); group chats finished on 26 Oct 2026 (COM-04).
// Group chats hold 3 to 50 people, their creator included. The product offers the ones an organiser
// starts from a completed event; POST /groups (custom groups from people one has met) has no screen yet.
//
// POST   /groups/from-event/:sessionId  { name?, memberIds? }  201 DmGroup & { memberCount }
// POST   /groups                        { name, memberIds }    201 DmGroup & { memberCount }   (custom)
// GET    /groups                                               DmGroupSummary[], most recent first
// GET    /groups/:id                                           DmGroupDetail (members, maxMembers)
// GET    /groups/:id/messages?before=<messageId>&limit=1..100  GroupChatMessagePage, newest first
// POST   /groups/:id/messages           { content }            201 { messageId, createdAt, message }
// POST   /groups/:id/read                                      { lastReadAt }
// POST   /groups/:id/leave                                     { left, newAdminId }
// POST   /groups/:id/members            { userIds }            { added, memberCount }   (the group's admin)
// DELETE /groups/:id/members/:userId                           { removedUserId }        (the group's admin)
//
// The service decides who may do what. Each change tells the screens once it has happened (fanout.ts
// says who); a message also pushes the bells it rang.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse, UserRole } from '@rsn/shared';
import { validate, validateAll } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { groupCreateLimiter, groupMessageLimiter, groupReadLimiter, groupWriteLimiter } from '../middleware/rateLimit';
import * as groupService from '../services/dm/group.service';
import { fanoutGroupEntities, fanoutGroupForUser } from '../realtime/fanout';

const router = Router();

// Postgres reads an upper-case uuid as the same row, but the service compares ids as plain strings.
const uuid = (message: string) => z.string().uuid(message).transform((s) => s.toLowerCase());
const storable = (s: string) => !s.includes('\u0000');

const groupParams = z.object({ id: uuid('Not a group id') });
const memberParams = z.object({ id: uuid('Not a group id'), userId: uuid('Not a member id') });
const sessionParams = z.object({ sessionId: uuid('Not an event id') });

// A list longer than any group could take is a runaway request; within it, the service gives the reason
// a group cannot take everyone ("This group is full (50 people).").
const people = z.array(uuid('Not a member id')).max(200, 'That is more people than a group can hold.');

const fromEventBody = z.object({
  name: z.string().trim().max(200, 'A group name can be up to 200 characters.')
    .refine(storable, 'That name has a character that cannot be saved.').optional(),
  memberIds: people.optional(),
});

const createCustomBody = z.object({
  name: z.string().min(1).max(200),
  memberIds: z.array(uuid('Not a member id')).min(1).max(50),
});

const messagesQuery = z.object({
  before: uuid('Not a message id').optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const sendBody = z.object({
  content: z.string({ required_error: 'Write a message first.' }).trim()
    .min(1, 'Write a message first.')
    .max(4000, 'Messages can be up to 4000 characters.')
    .refine(storable, 'That message has a character that cannot be sent.'),
});

const addBody = z.object({ userIds: people.min(1, 'Choose someone to add.') });

// validate() has already replaced req.query with the parsed value, but Express types it loosely.
type MessagesQuery = z.infer<typeof messagesQuery>;

// POST /groups/from-event/:sessionId — an organiser starts a group with the people who took part
router.post(
  '/from-event/:sessionId',
  authenticate,
  groupCreateLimiter,
  validateAll({ params: sessionParams, body: fromEventBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, memberIds } = req.body as z.infer<typeof fromEventBody>;
      const data = await groupService.createGroupFromEvent(
        { userId: req.user!.userId, role: req.user!.role as UserRole },
        req.params.sessionId,
        { name, memberIds },
      );
      void fanoutGroupEntities(data.id);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups — create a custom group (no screen uses it yet)
router.post(
  '/',
  authenticate,
  groupCreateLimiter,
  validate(createCustomBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.createCustomGroup(req.user!.userId, req.body.name, req.body.memberIds);
      void fanoutGroupEntities(data.id);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// GET /groups — the groups I am in
router.get(
  '/',
  authenticate,
  groupReadLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.listMyGroups(req.user!.userId);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// GET /groups/:id — one group, its members and the cap
router.get(
  '/:id',
  authenticate,
  groupReadLimiter,
  validate(groupParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.getGroup(req.params.id, req.user!.userId);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// GET /groups/:id/messages — a page of messages, newest first
router.get(
  '/:id/messages',
  authenticate,
  groupReadLimiter,
  validateAll({ params: groupParams, query: messagesQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { before, limit } = req.query as unknown as MessagesQuery;
      const data = await groupService.listGroupMessages(req.params.id, req.user!.userId, { before, limit });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups/:id/messages — write in a group
router.post(
  '/:id/messages',
  authenticate,
  groupMessageLimiter,
  validateAll({ params: groupParams, body: sendBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sent = await groupService.sendGroupMessage(req.params.id, req.user!.userId, req.body.content);
      void fanoutGroupEntities(req.params.id);
      void groupService.pushGroupBells(sent.bells);
      const data = { messageId: sent.message.id, createdAt: sent.message.createdAt, message: sent.message };
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups/:id/read — I have read the group up to now
router.post(
  '/:id/read',
  authenticate,
  groupWriteLimiter,
  validate(groupParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.markGroupRead(req.params.id, req.user!.userId);
      void fanoutGroupForUser(req.params.id, req.user!.userId);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups/:id/leave — leave a group (the earliest member takes over from a leaving admin)
router.post(
  '/:id/leave',
  authenticate,
  groupWriteLimiter,
  validate(groupParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.leaveGroup(req.params.id, req.user!.userId);
      if (data.left) void fanoutGroupEntities(req.params.id, [req.user!.userId]);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /groups/:id/members — the group's admin adds people who took part in its event
router.post(
  '/:id/members',
  authenticate,
  groupWriteLimiter,
  validateAll({ params: groupParams, body: addBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.addGroupMembers(req.params.id, req.user!.userId, req.body.userIds);
      if (data.added.length > 0) void fanoutGroupEntities(req.params.id);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /groups/:id/members/:userId — the group's admin removes someone
router.delete(
  '/:id/members/:userId',
  authenticate,
  groupWriteLimiter,
  validate(memberParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await groupService.removeGroupMember(req.params.id, req.user!.userId, req.params.userId);
      void fanoutGroupEntities(req.params.id, [data.removedUserId]);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
