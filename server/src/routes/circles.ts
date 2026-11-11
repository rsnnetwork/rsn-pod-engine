// ─── Circle Routes ───────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). Authz per the architecture matrix:
// create/update/archive/attach = admin+; join/leave/read = any authenticated
// member. Every gate is server-side — nothing trusted from the client.
// 1 Nov 2026: every route is rate limited (circleReadLimiter, circleWriteLimiter, and wallWriteLimiter on the wall's
// writes; the wall's reads joined circleReadLimiter on 2 Nov) and every change to a circle tells the people it touches
// through fanoutCircleChange.
// T14 (1 Nov 2026, L22): the people who run a circle (its creator, owners and moderators, and platform admins;
// circle-managers.ts) edit it, choose Open or Closed, answer asks to join, remove members and attach pods. Creating
// and archiving a circle stay a platform admin's. Every change to the asks also tells circle:<id>:requests.
// T15 (30 Oct review 7.3): the people who run a circle link entities to it and unlink them (an entity's own admins may
// also unlink it); each link tells circle:<id> and entity:<id>.
// Shirley pilot S2 (11 Nov 2026, D3): authority comes from the role alone (circle-managers.ts). Moderators run the
// circle with its owner; only the owner (or a platform admin) chooses who can join, makes and unmakes moderators
// (PATCH /:id/members/:userId/role) and hands the circle to someone else in it (POST /:id/transfer). A pod's own
// director may take their pod out of any circle. Which circles a pod is in is read only by someone who may see the pod.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { PATH_REFUSALS, uuidInPath } from '../middleware/path-ids';
import { requireRole } from '../middleware/rbac';
import { circleReadLimiter, circleWriteLimiter, wallWriteLimiter } from '../middleware/rateLimit';
import { fanoutCircleChange, fanoutEntityChange, fanoutOwnInvites, fanoutPodEntities } from '../realtime/fanout';
import { E } from '../realtime/entities';
import { ApiResponse, UserRole } from '@rsn/shared';
import * as circleService from '../services/circle/circle.service';
import * as joinService from '../services/circle/circle-join.service';
import * as linkService from '../services/circle/circle-entities.service';
import * as wallService from '../services/circle/circle-wall.service';
import * as roleService from '../services/circle/circle-roles.service';
import { assertCircleManager, assertCircleOwner } from '../services/circle/circle-managers';
import { canViewPod } from '../services/pods/pod-access';
import { NotFoundError } from '../middleware/errors';

const router = Router();

const isAdminRole = (role?: string) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;

const createBodySchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional().nullable(),
  parentCircleId: z.string().uuid().optional().nullable(),
});
const updateBodySchema = createBodySchema.partial().extend({
  // T14: who can join. Production's client never sends it.
  joinPolicy: z.enum(['open', 'closed']).optional(),
});
const attachBodySchema = z.object({ podId: z.string().uuid().transform((s) => s.toLowerCase()) });
// S2: the roles the owner gives and takes ('owner' moves only through a handover).
const roleBodySchema = z.object({
  role: z.enum(['moderator', 'member'], { errorMap: () => ({ message: 'Choose moderator or member.' }) }),
});
const transferBodySchema = z.object({
  toUserId: z.string({ required_error: 'Choose who will own the circle.' }).uuid('Choose who will own the circle.')
    .transform((s) => s.toLowerCase()),
});
const attachableQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).optional()
    .transform((n) => Math.min(n ?? joinService.ATTACHABLE_PAGE, joinService.ATTACHABLE_PAGE_MAX)),
});
type AttachableQuery = z.infer<typeof attachableQuery>;

// GET /circles — list (any member)
router.get('/', authenticate, circleReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleService.listCircles(req.user!.userId, req.user!.role);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// GET /circles/of-pod/:podId — circles a pod is attached to, for anyone who may see the pod (S2: a private pod's
// links are its members' and admins' to read; anyone else gets the pod's own 404, so its existence is not confirmed).
// Two path segments, so it can never be shadowed by GET /:id below.
router.get('/of-pod/:podId', authenticate, circleReadLimiter, uuidInPath('podId', PATH_REFUSALS.pod), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await canViewPod(req.user!.userId, req.params.podId, req.user!.role))) throw new NotFoundError('Pod', req.params.podId);
    const data = await circleService.listCirclesOfPod(req.params.podId);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// GET /circles/:id — detail (any member). A malformed id is a 400 in a member's words (26 Oct 2026).
router.get('/:id', authenticate, circleReadLimiter, uuidInPath('id', PATH_REFUSALS.circle), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await circleService.getCircleDetail(req.params.id, req.user!.userId, req.user!.role);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles — create (admin+)
router.post('/', authenticate, circleWriteLimiter, requireRole(UserRole.ADMIN), validate(createBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await circleService.createCircle(req.user!.userId, req.body);
      void fanoutCircleChange(data.id, req.user!.userId, [req.user!.userId]);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// PATCH /circles/:id — update (the people who run it; T14). Name and description: its owner and moderators. Who can
// join (S2, D3): its owner only, since opening a closed circle lets everyone waiting in. Moving it under another
// circle stays a platform admin's (the service says so).
router.patch('/:id', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), validate(updateBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const circle = req.body.joinPolicy !== undefined
        ? await assertCircleOwner(req.params.id, req.user!.userId, req.user!.role, "Only the circle's owner can choose who can join.")
        : await assertCircleManager(req.params.id, req.user!.userId, req.user!.role, 'Only the people who run this circle can change it.');
      const changed = await circleService.updateCircle(req.params.id, req.body, { userId: req.user!.userId, role: req.user!.role });
      const approved = changed?.approvedUserIds ?? [];
      // Closing withdraws the invites of people who do not run it (final fix wave S2): the circle's invites and each
      // inviter's and invitee's own list change.
      const policyTags = req.body.joinPolicy === undefined ? []
        : [E.circleRequests(req.params.id), ...(req.body.joinPolicy === 'closed' ? [E.circleInvites(req.params.id)] : [])];
      void fanoutCircleChange(req.params.id, req.user!.userId, approved, policyTags);
      if (changed?.invitesChangedFor?.length) void fanoutOwnInvites(changed.invitesChangedFor);
      void joinService.ringApproved(req.params.id, req.body.name?.trim() || circle.name, approved);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/archive — archive (admin+); never a hard delete
router.post('/:id/archive', authenticate, circleWriteLimiter, requireRole(UserRole.ADMIN), uuidInPath('id', PATH_REFUSALS.circle),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await circleService.archiveCircle(req.params.id);
      void fanoutCircleChange(req.params.id, req.user!.userId);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circles/:id/attachable-pods — the attach picker's list, a page at a time (the people who run it; T14)
router.get('/:id/attachable-pods', authenticate, circleReadLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  validate(attachableQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // validate() has replaced req.query with the parsed value; Express still types it as raw strings.
      const asked = req.query as unknown as AttachableQuery;
      const data = await joinService.listAttachablePods(req.params.id, { userId: req.user!.userId, role: req.user!.role },
        { q: asked.q, page: asked.page, pageSize: asked.pageSize });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/pods — attach a pod (the people who run it; T14). A platform admin attaches any pod, anyone
// else a pod they direct or host.
router.post('/:id/pods', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), validate(attachBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await assertCircleManager(req.params.id, req.user!.userId, req.user!.role, 'Only the people who run this circle can attach pods.');
      await circleService.attachPod(req.params.id, req.body.podId, req.user!.userId, isAdminRole(req.user!.role));
      void fanoutCircleChange(req.params.id, req.user!.userId);
      // S2: the pod's own page names its circles ("In circles"), so its members are told too.
      void fanoutPodEntities(req.body.podId);
      res.status(201).json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/:id/pods/:podId — take a pod out of the circle: the people who run the circle (T14), or (S2) the
// pod's own director, who may always unlink their pod. Only the link goes; the pod keeps everything of its own.
router.delete('/:id/pods/:podId', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  uuidInPath('podId', PATH_REFUSALS.pod),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const podId = req.params.podId.toLowerCase();
      const { detached } = await circleService.detachPod(req.params.id, podId, { userId: req.user!.userId, role: req.user!.role });
      if (detached) {
        void fanoutCircleChange(req.params.id, req.user!.userId);
        void fanoutPodEntities(podId);
      }
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/join — any member joins an open circle; a closed one answers 403 CIRCLE_CLOSED (ask instead)
router.post('/:id/join', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await circleService.joinCircle(req.params.id, req.user!.userId, { role: req.user!.role });
    void fanoutCircleChange(req.params.id, req.user!.userId, [req.user!.userId]);
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/:id/leave — (any member)
router.post('/:id/leave', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await circleService.leaveCircle(req.params.id, req.user!.userId);
    void fanoutCircleChange(req.params.id, req.user!.userId, [req.user!.userId]);
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// ── Asking to join, and the answers (T14) ───────────────────────────────────────────────────────────────

const askTags = (circleId: string) => [E.circleRequests(circleId)];

// POST /circles/:id/request — ask to join. An open circle (or someone who runs it) simply joins: { status: 'member' }.
router.post('/:id/request', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = await joinService.requestToJoinCircle(req.params.id, req.user!.userId, req.user!.role);
      void fanoutCircleChange(req.params.id, req.user!.userId, [req.user!.userId], askTags(req.params.id));
      res.json({ success: true, data: { status } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/:id/request — withdraw your own ask (a second press answers the same)
router.delete('/:id/request', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await joinService.cancelJoinRequest(req.params.id, req.user!.userId);
      if (data.cancelled) void fanoutCircleChange(req.params.id, req.user!.userId, [req.user!.userId], askTags(req.params.id));
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circles/:id/requests — the asks waiting (the people who run it)
router.get('/:id/requests', authenticate, circleReadLimiter, uuidInPath('id', PATH_REFUSALS.circle),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await joinService.listJoinRequests(req.params.id, { userId: req.user!.userId, role: req.user!.role });
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/requests/:userId/approve | decline — answer one ask (the people who run it), once
for (const verb of ['approve', 'decline'] as const) {
  router.post(`/:id/requests/:userId/${verb}`, authenticate, circleWriteLimiter,
    uuidInPath('id', PATH_REFUSALS.circle), uuidInPath('userId', PATH_REFUSALS.member),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const decider = { userId: req.user!.userId, role: req.user!.role };
        if (verb === 'approve') await joinService.approveJoinRequest(req.params.id, req.params.userId, decider);
        else await joinService.declineJoinRequest(req.params.id, req.params.userId, decider);
        void fanoutCircleChange(req.params.id, req.user!.userId, [req.params.userId], askTags(req.params.id));
        res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
      } catch (err) { next(err); }
    });
}

// DELETE /circles/:id/members/:userId — remove a member (the people who run it; never the owner)
router.delete('/:id/members/:userId', authenticate, circleWriteLimiter,
  uuidInPath('id', PATH_REFUSALS.circle), uuidInPath('userId', PATH_REFUSALS.member),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await joinService.removeCircleMember(req.params.id, req.params.userId, { userId: req.user!.userId, role: req.user!.role });
      void fanoutCircleChange(req.params.id, req.user!.userId, [req.params.userId]);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// ── Roles (Shirley pilot S2, 11 Nov 2026; D3) ─────────────────────────────────────────────────────────────

// PATCH /circles/:id/members/:userId/role { role: 'moderator' | 'member' } — the owner (or a platform admin) makes a
// member a moderator or a moderator a member. Audited; everyone in the circle and the person changed are told.
router.patch('/:id/members/:userId/role', authenticate, circleWriteLimiter,
  uuidInPath('id', PATH_REFUSALS.circle), uuidInPath('userId', PATH_REFUSALS.member), validate(roleBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetId = req.params.userId.toLowerCase();
      const { role } = req.body as z.infer<typeof roleBodySchema>;
      const change = await roleService.setCircleMemberRole(req.params.id, targetId, role, { userId: req.user!.userId, role: req.user!.role });
      if (change.changed) void fanoutCircleChange(req.params.id, req.user!.userId, [targetId]);
      res.json({ success: true, data: { role: change.to, changed: change.changed } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/:id/transfer { toUserId } — the owner (or a platform admin) hands the circle to someone in it; the old
// owner becomes a moderator. Audited; both people and everyone in the circle are told, and the new owner gets a bell.
router.post('/:id/transfer', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), validate(transferBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { toUserId } = req.body as z.infer<typeof transferBodySchema>;
      const handover = await roleService.transferCircleOwnership(req.params.id, toUserId, { userId: req.user!.userId, role: req.user!.role });
      const changed = [toUserId, ...(handover.previousOwnerId ? [handover.previousOwnerId] : [])];
      void fanoutCircleChange(req.params.id, req.user!.userId, changed);
      void joinService.ringNewOwner(req.params.id, handover.circleName, toUserId);
      res.json({ success: true, data: { ownerId: toUserId, previousOwnerId: handover.previousOwnerId } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// ── Entities linked to the circle (T15, 30 Oct review 7.3; L23) ───────────────────────────────────────────

const linkEntityBody = z.object({
  entityId: z.string({ required_error: 'Choose an entity to link.' }).uuid("We couldn't find that entity.")
    .transform((s) => s.toLowerCase()),
});

// POST /circles/:id/entities { entityId } — link an entity (the people who run it); linking twice adds nothing
router.post('/:id/entities', authenticate, circleWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), validate(linkEntityBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { entityId } = req.body as z.infer<typeof linkEntityBody>;
      await linkService.linkEntity(req.params.id, entityId, { userId: req.user!.userId, role: req.user!.role });
      void fanoutCircleChange(req.params.id, req.user!.userId);
      void fanoutEntityChange(entityId, req.user!.userId);
      res.status(201).json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/:id/entities/:entityId — unlink (the people who run it, or the entity's own admins)
router.delete('/:id/entities/:entityId', authenticate, circleWriteLimiter,
  uuidInPath('id', PATH_REFUSALS.circle), uuidInPath('entityId', "We couldn't find that entity."),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { unlinked } = await linkService.unlinkEntity(req.params.id, req.params.entityId, { userId: req.user!.userId, role: req.user!.role });
      // A link that was not there changed nothing, so no screen needs telling.
      if (unlinked) {
        void fanoutCircleChange(req.params.id, req.user!.userId);
        void fanoutEntityChange(req.params.entityId, req.user!.userId);
      }
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
// 4 Sep 2026: replies (one level; the service attaches a reply-to-a-reply to
// the top-level comment), reactions, comment likes, shares into another circle.
const commentSchema = z.object({
  content: z.string().min(1).max(4000),
  parentCommentId: z.string().uuid().optional().nullable(),
});
const reactSchema = z.object({ reaction: z.enum(['like', 'love', 'applause', 'insightful', 'celebrate']).nullable() });
const likeSchema = z.object({ liked: z.boolean() });
const shareSchema = z.object({
  circleId: z.string().uuid(),
  clientId: z.string().uuid(),
  content: z.string().max(2000).optional(),
});
// Final fix wave SM3 (2 Nov 2026): a malformed post or comment id is a 400 in words, never a Postgres 500.
const postInPath = uuidInPath('postId', PATH_REFUSALS.post);
const commentInPath = uuidInPath('commentId', PATH_REFUSALS.comment);

// GET /circles/:id/posts — the wall feed (any member; a closed circle's only to the people in it; keyset cursor)
router.get('/:id/posts', authenticate, circleReadLimiter, uuidInPath('id', PATH_REFUSALS.circle), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await wallService.listPosts(req.params.id, req.user!.userId, {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    }, req.user!.role);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/:id/posts — create (CIRCLE MEMBERS only, enforced in service)
router.post('/:id/posts', authenticate, wallWriteLimiter, uuidInPath('id', PATH_REFUSALS.circle), validate(createPostSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.createPost(req.params.id, req.user!.userId, req.body);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circles/posts/:postId — one post (any member; blocks respected → 404). Backs ?post= deep links.
router.get('/posts/:postId', authenticate, circleReadLimiter, postInPath, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await wallService.getPost(req.params.postId, req.user!.userId, req.user!.role);
    if (!data) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Post not found' } } satisfies ApiResponse);
      return;
    }
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/posts/:postId/react — set or clear (reaction: null) the member's one reaction
router.post('/posts/:postId/react', authenticate, wallWriteLimiter, postInPath, validate(reactSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.reactToPost(req.params.postId, req.user!.userId, req.body.reaction);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/posts/:postId/share — repost into another circle with attribution
router.post('/posts/:postId/share', authenticate, wallWriteLimiter, postInPath, validate(shareSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.sharePost(req.params.postId, req.user!.userId, req.body);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/posts/:postId — author (own) or admin (any); soft delete
router.delete('/posts/:postId', authenticate, wallWriteLimiter, postInPath, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await wallService.deletePost(req.params.postId, req.user!.userId, isAdminRole(req.user!.role));
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/posts/:postId/pin + /unpin — admin only
router.post('/posts/:postId/pin', authenticate, wallWriteLimiter, requireRole(UserRole.ADMIN), postInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wallService.pinPost(req.params.postId, true);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });
router.post('/posts/:postId/unpin', authenticate, wallWriteLimiter, requireRole(UserRole.ADMIN), postInPath,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await wallService.pinPost(req.params.postId, false);
      res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// GET /circles/posts/:postId/comments — any member (blocks filtered)
router.get('/posts/:postId/comments', authenticate, circleReadLimiter, postInPath, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await wallService.listComments(req.params.postId, req.user!.userId, req.user!.role);
    res.json({ success: true, data } satisfies ApiResponse);
  } catch (err) { next(err); }
});

// POST /circles/posts/:postId/comments — circle members only (service-enforced)
router.post('/posts/:postId/comments', authenticate, wallWriteLimiter, postInPath, validate(commentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.addComment(req.params.postId, req.user!.userId, req.body.content, req.body.parentCommentId ?? null);
      res.status(201).json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// POST /circles/comments/:commentId/like — like / unlike a comment (members)
router.post('/comments/:commentId/like', authenticate, wallWriteLimiter, commentInPath, validate(likeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await wallService.likeComment(req.params.commentId, req.user!.userId, req.body.liked);
      res.json({ success: true, data } satisfies ApiResponse);
    } catch (err) { next(err); }
  });

// DELETE /circles/comments/:commentId — author or admin; soft delete (replies go with it)
router.delete('/comments/:commentId', authenticate, wallWriteLimiter, commentInPath, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await wallService.deleteComment(req.params.commentId, req.user!.userId, isAdminRole(req.user!.role));
    res.json({ success: true, data: { ok: true } } satisfies ApiResponse);
  } catch (err) { next(err); }
});

export default router;
