// ─── Pod Wall Routes (26 Oct 2026) ───────────────────────────────────────────
// A pod's discussion. Mounted at /api/pods; every path is nested under :podId, so the pod and the member's
// place in it are checked once by the service and the post is looked up inside that pod only.
//
// GET    /:podId/wall/posts?cursor=                       { pinned, posts, nextCursor, viewer }
// POST   /:podId/wall/posts                               { clientId, content?, media? }  201 the post
// GET    /:podId/wall/posts/:postId                       one post (backs a ?post= link)
// DELETE /:podId/wall/posts/:postId                       { ok: true }   the author; the pod's director or host; admins
// POST   /:podId/wall/posts/:postId/pin | unpin           { ok: true }   the pod's director or host; admins
// POST   /:podId/wall/posts/:postId/react                 { reaction: 'like' | 'love' | 'applause' | 'insightful' | 'celebrate' | null }
// GET    /:podId/wall/posts/:postId/comments              the comments, replies under their comment
// POST   /:podId/wall/posts/:postId/comments              { content, parentCommentId? }  201 { id, createdAt, parentCommentId }
// POST   /:podId/wall/comments/:commentId/like            { liked }  { likeCount, likedByMe }
// DELETE /:podId/wall/comments/:commentId                 { ok: true }
//
// The service decides who may do what, and tells the pod's screens and rings the bells once a write has
// been saved. The routes check the shape of what was sent. Reads are covered by the API limiter in front of
// every route; every write also carries wallWriteLimiter.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { wallWriteLimiter } from '../middleware/rateLimit';
import { REACTION_KINDS } from '../services/circle/circle-wall.service';
import * as wall from '../services/pod/pod-wall.service';

const router = Router();

// ── What each route accepts ──────────────────────────────────────────────────

// Postgres reads an upper-case uuid as the same row, but the services compare ids as plain strings.
const id = (what: string) => z.string().uuid(`Not a ${what} id`).transform((s) => s.toLowerCase());
const podParams = z.object({ podId: id('pod') });
const postParams = podParams.extend({ postId: id('post') });
const commentParams = podParams.extend({ commentId: id('comment') });

const feedQuery = z.object({ cursor: z.string().max(100).optional() });

const mediaItem = z.object({
  type: z.enum(['image', 'video']),
  url: z.string().max(2000),
  meta: z.record(z.unknown()).optional().nullable(),
});
const createPostBody = z.object({
  clientId: z.string().uuid(),
  content: z.string().max(8000, 'Keep a post to 8000 characters.').optional(),
  media: z.array(mediaItem).max(4, 'Attach at most 4 pictures.').optional(),
});
const commentBody = z.object({
  content: z.string().min(1, 'Write a comment first.').max(4000, 'Keep a comment to 4000 characters.'),
  parentCommentId: z.string().uuid().optional().nullable(),
});
const reactBody = z.object({ reaction: z.enum(REACTION_KINDS).nullable() });
const likeBody = z.object({ liked: z.boolean() });

// validate() has already replaced req.params, req.query and req.body with the parsed value, but Express
// types them loosely.
type FeedQuery = z.infer<typeof feedQuery>;
type CreatePostBody = z.infer<typeof createPostBody>;
type CommentBody = z.infer<typeof commentBody>;
type ReactBody = z.infer<typeof reactBody>;
type LikeBody = z.infer<typeof likeBody>;

const viewerOf = (req: Request): wall.WallViewer => ({ userId: req.user!.userId, role: req.user!.role });
const ok = { success: true, data: { ok: true } } satisfies ApiResponse;

// ── Reading ──────────────────────────────────────────────────────────────────

router.get('/:podId/wall/posts', authenticate, validate(podParams, 'params'), validate(feedQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cursor } = req.query as FeedQuery;
      const data = await wall.listPosts(req.params.podId, viewerOf(req), { cursor });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.get('/:podId/wall/posts/:postId', authenticate, validate(postParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wall.getPost(req.params.podId, req.params.postId, viewerOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.get('/:podId/wall/posts/:postId/comments', authenticate, validate(postParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wall.listComments(req.params.podId, req.params.postId, viewerOf(req));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// ── Writes ───────────────────────────────────────────────────────────────────

router.post('/:podId/wall/posts', authenticate, wallWriteLimiter, validate(podParams, 'params'), validate(createPostBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wall.createPost(req.params.podId, viewerOf(req), req.body as CreatePostBody);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.delete('/:podId/wall/posts/:postId', authenticate, wallWriteLimiter, validate(postParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wall.deletePost(req.params.podId, req.params.postId, viewerOf(req));
      res.json(ok);
    } catch (err) { next(err); }
  });

router.post('/:podId/wall/posts/:postId/pin', authenticate, wallWriteLimiter, validate(postParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wall.setPinned(req.params.podId, req.params.postId, viewerOf(req), true);
      res.json(ok);
    } catch (err) { next(err); }
  });

router.post('/:podId/wall/posts/:postId/unpin', authenticate, wallWriteLimiter, validate(postParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wall.setPinned(req.params.podId, req.params.postId, viewerOf(req), false);
      res.json(ok);
    } catch (err) { next(err); }
  });

router.post('/:podId/wall/posts/:postId/react', authenticate, wallWriteLimiter, validate(postParams, 'params'), validate(reactBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wall.reactToPost(req.params.podId, req.params.postId, viewerOf(req), (req.body as ReactBody).reaction);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.post('/:podId/wall/posts/:postId/comments', authenticate, wallWriteLimiter, validate(postParams, 'params'), validate(commentBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as CommentBody;
      const data = await wall.addComment(req.params.podId, req.params.postId, viewerOf(req), {
        content: body.content, parentCommentId: body.parentCommentId ?? null,
      });
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.post('/:podId/wall/comments/:commentId/like', authenticate, wallWriteLimiter, validate(commentParams, 'params'), validate(likeBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wall.likeComment(req.params.podId, req.params.commentId, viewerOf(req), (req.body as LikeBody).liked);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

router.delete('/:podId/wall/comments/:commentId', authenticate, wallWriteLimiter, validate(commentParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wall.deleteComment(req.params.podId, req.params.commentId, viewerOf(req));
      res.json(ok);
    } catch (err) { next(err); }
  });

export default router;
