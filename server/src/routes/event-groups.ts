// ─── An event's matching groups (10 Nov 2026 spec, Part 2 Task 5) ─────────────────────────────────────────
//
// GET /sessions/:id/groups                           EventGroupsView: the groups, the question, my groups;
//                                                    the people running it also get rules, counts, capacity
// PUT /sessions/:id/groups                           the organiser saves the groups and round rules
// PUT /sessions/:id/participants/:userId/groups      the organiser puts a person in groups { groupKeys }
//
// Mounted at /api/sessions beside the event routes. The routes check the shape of what was sent; the service
// decides who may read and change (organisers are canActAsHost), refuses while the event is live, audits, and
// tells the screens (session:<id>:groups to the people running the event and everyone who holds a place).

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DEFAULT_GROUP_QUESTION, GROUP_LIMITS, type ApiResponse, type EventGroupRules, type EventGroupsView } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { eventChatReadLimiter, groupsWriteLimiter } from '../middleware/rateLimit';
import { readEventGroups, saveEventGroupRules, setParticipantGroups } from '../services/session/event-groups.service';

const router = Router();

const uuid = (message: string) => z.string().uuid(message).transform((s) => s.toLowerCase());
const eventParams = z.object({ id: uuid('Not an event id') });
const personParams = eventParams.extend({ userId: uuid('Not a member id') });

const groupKey = z.string().regex(/^[a-z0-9_]{1,32}$/, 'A group needs a short name made of letters and numbers.');
/** Group keys as a participant or organiser sends them (the service checks they are the event's). */
export const groupKeysSchema = z.array(groupKey).max(GROUP_LIMITS.maxGroups);

const roundRule = z.object({
  fromRound: z.number().int().min(1).max(100),
  toRound: z.number().int().min(1).max(100),
  mode: z.enum(['open', 'cross_group', 'custom']),
  allowedPairs: z.array(z.string().max(65)).max(78).default([]),
});

const rulesBody = z.object({
  groups: z.array(z.object({
    key: groupKey,
    label: z.string().trim().min(1, 'Give the group a name.').max(GROUP_LIMITS.labelMaxLength),
    description: z.string().trim().max(GROUP_LIMITS.descriptionMaxLength).nullable().optional(),
  })).max(GROUP_LIMITS.maxGroups, `An event can have at most ${GROUP_LIMITS.maxGroups} groups.`),
  question: z.string().trim().min(1).max(GROUP_LIMITS.questionMaxLength).optional(),
  allowMultiple: z.boolean().default(false),
  fallback: z.enum(['leave_unmatched', 'same_group_meeting']).default('leave_unmatched'),
  rounds: z.array(roundRule).max(100).default([]),
});
type RulesBody = z.infer<typeof rulesBody>;

const personBody = z.object({ groupKeys: groupKeysSchema });

// A read changes nothing, so it tells no screens.
router.get('/:id/groups', authenticate, eventChatReadLimiter, validate(eventParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await readEventGroups(req.params.id, { userId: req.user!.userId, role: req.user!.role });
      res.json({ success: true, data } satisfies ApiResponse<EventGroupsView>);
    } catch (err) {
      next(err);
    }
  });

router.put('/:id/groups', authenticate, groupsWriteLimiter, validate(eventParams, 'params'), validate(rulesBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as RulesBody;
      const rules: EventGroupRules = {
        groups: body.groups.map((g) => ({ key: g.key, label: g.label, description: g.description ?? null })),
        question: body.question ?? DEFAULT_GROUP_QUESTION,
        allowMultiple: body.allowMultiple,
        fallback: body.fallback,
        rounds: body.rounds,
      };
      const data = await saveEventGroupRules(req.params.id, { userId: req.user!.userId, role: req.user!.role }, rules);
      res.json({ success: true, data } satisfies ApiResponse<EventGroupRules>);
    } catch (err) {
      next(err);
    }
  });

router.put('/:id/participants/:userId/groups', authenticate, groupsWriteLimiter, validate(personParams, 'params'), validate(personBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupKeys } = req.body as z.infer<typeof personBody>;
      await setParticipantGroups(
        req.params.id, { userId: req.user!.userId, role: req.user!.role }, req.params.userId, groupKeys, 'organiser',
      );
      res.json({ success: true, data: { groupKeys } } satisfies ApiResponse);
    } catch (err) {
      next(err);
    }
  });

export default router;
