// ─── Circle Routes ───────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). Authz per the architecture matrix:
// create/update/archive/attach = admin+; join/leave/read = any authenticated
// member. Every gate is server-side — nothing trusted from the client.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { ApiResponse, UserRole } from '@rsn/shared';
import * as circleService from '../services/circle/circle.service';
import * as wallService from '../services/circle/circle-wall.service';

const router = Router();

const isAdminRole = (role?: string) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

const createBodySchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional().nullable(),
  parentCircleId: z.string().uuid().optional().nullable(),
});
const updateBodySchema = createBodySchema.partial();
const attachBodySchema = z.object({ podId: z.string().uuid() });

// GET /circles — list (any member)
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleService.listCircles(req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// GET /circles/of-pod/:podId — circles a pod is attached to (any member).
// Two path segments, so it can never be shadowed by GET /:id below.
router.get('/of-pod/:podId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleService.listCirclesOfPod(req.params.podId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// GET /circles/:id — detail (any member)
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleService.getCircleDetail(req.params.id, req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles — create (admin+)
router.post('/', authenticate, requireRole(UserRole.ADMIN), validate(createBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await circleService.createCircle(req.user!.userId, req.body);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// PATCH /circles/:id — update (admin+)
router.patch('/:id', authenticate, requireRole(UserRole.ADMIN), validate(updateBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await circleService.updateCircle(req.params.id, req.body);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/archive — archive (admin+); never a hard delete
router.post('/:id/archive', authenticate, requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await circleService.archiveCircle(req.params.id);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/pods — attach a pod (admin+)
router.post('/:id/pods', authenticate, requireRole(UserRole.ADMIN), validate(attachBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await circleService.attachPod(req.params.id, req.body.podId, req.user!.userId);
      res.status(201).json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/:id/pods/:podId — detach (admin+)
router.delete('/:id/pods/:podId', authenticate, requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await circleService.detachPod(req.params.id, req.params.podId);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/join — open join (any member)
router.post('/:id/join', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await circleService.joinCircle(req.params.id, req.user!.userId);
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/:id/leave — (any member)
router.post('/:id/leave', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await circleService.leaveCircle(req.params.id, req.user!.userId);
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// ── Wall (Phase 4) ───────────────────────────────────────────────────────────

const createPostSchema = z.object({
  clientId: z.string().uuid(),
  content: z.string().max(8000).optional(),
  media: z.array(z.object({
    type: z.enum(['image', 'video']),
    url: z.string().max(2000),
    meta: z.record(z.any()).optional().nullable(),
  })).max(4).optional(),
});
const commentSchema = z.object({ content: z.string().min(1).max(4000) });

// GET /circles/:id/posts — the wall feed (any member; keyset cursor)
router.get('/:id/posts', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await wallService.listPosts(req.params.id, req.user!.userId, {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    });
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/:id/posts — create (CIRCLE MEMBERS only, enforced in service)
router.post('/:id/posts', authenticate, validate(createPostSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.createPost(req.params.id, req.user!.userId, req.body);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/posts/:postId — author (own) or admin (any); soft delete
router.delete('/posts/:postId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await wallService.deletePost(req.params.postId, req.user!.userId, isAdminRole(req.user!.role));
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/posts/:postId/pin + /unpin — admin only
router.post('/posts/:postId/pin', authenticate, requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wallService.pinPost(req.params.postId, true);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });
router.post('/posts/:postId/unpin', authenticate, requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wallService.pinPost(req.params.postId, false);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circles/posts/:postId/comments — any member (blocks filtered)
router.get('/posts/:postId/comments', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await wallService.listComments(req.params.postId, req.user!.userId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/posts/:postId/comments — circle members only (service-enforced)
router.post('/posts/:postId/comments', authenticate, validate(commentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.addComment(req.params.postId, req.user!.userId, req.body.content);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/comments/:commentId — author or admin; soft delete
router.delete('/comments/:commentId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await wallService.deleteComment(req.params.commentId, req.user!.userId, isAdminRole(req.user!.role));
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

export default router;
