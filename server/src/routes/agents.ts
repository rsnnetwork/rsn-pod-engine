// ─── Matching Agents routes (Wave 2 core, 3 Aug 2026) ────────────────────────
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
//
// An agent is one standing reason to meet people. Members hold several at once,
// each with its own stored matches, so the dashboard can show "Developer: 3,
// Investor: 0" without re-scoring the network on every render.
//
// Every mutation rescores in the BACKGROUND and answers immediately: scoring
// walks all eligible members, and no member should wait on that to see their
// agent appear. The count catches up within a second.

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import * as agentRepo from '../services/matching/agent.repo';
import * as agentMatching from '../services/matching/agent-matching.service';
import * as platformMatch from '../services/matching/platform-match.service';
import { fanoutUserEntity } from '../realtime/fanout';
import logger from '../config/logger';
import { ApiResponse } from '@rsn/shared';
import { AppError, NotFoundError } from '../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const router = Router();

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  wantText: z.string().trim().min(1).max(2000),
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  wantText: z.string().trim().min(1).max(2000).optional(),
});

const statusSchema = z.object({
  status: z.enum(['active', 'paused', 'archived']),
});

/** Rescore without making the caller wait. Never rejects into the request. */
function rescoreInBackground(agent: { id: string; userId: string; wantText: string; label: string }): void {
  agentMatching
    .recomputeAgent(agent)
    .then((n) => fanoutUserEntity(agent.userId).catch(() => { void n; }))
    .catch((err) => logger.warn({ err, agentId: agent.id }, 'background agent rescore failed'));
}

// GET /agents — the dashboard: every agent with its live count.
//
// An agent that has never been scored is answered immediately and then scored
// in the background, so it fills in on the next poll. This is what makes the
// seeded agents work: migration 086 created one per existing member from what
// they already told us, but creating a row runs no search, and without this
// every one of them would sit at "0 potential matches" forever.
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
    const agents = await agentRepo.listAgents(req.user!.userId, { includeArchived });
    res.json({ success: true, data: agents } as ApiResponse);
    for (const a of agents) {
      if (a.status === 'active' && a.lastMatchedAt === null) rescoreInBackground(a);
    }
  } catch (err) { next(err); }
});

// POST /agents — create, then rescore in the background.
router.post('/', authenticate, validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await agentRepo.createAgent(req.user!.userId, {
      label: req.body.label,
      wantText: req.body.wantText,
    });
    res.status(201).json({ success: true, data: agent } as ApiResponse);
    rescoreInBackground(agent);
  } catch (err) { next(err); }
});

// GET /agents/:id — one agent plus the people it found.
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await agentRepo.getAgent(req.params.id, req.user!.userId);
    if (!agent) throw new NotFoundError('Agent', req.params.id);
    const matches = await agentRepo.listMatches(agent.id);
    res.json({ success: true, data: { agent, matches } } as ApiResponse);
  } catch (err) { next(err); }
});

// PATCH /agents/:id — editing what it looks for invalidates its results.
router.patch('/:id', authenticate, validate(updateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await agentRepo.updateAgent(req.params.id, req.user!.userId, {
      label: req.body.label,
      wantText: req.body.wantText,
    });
    if (!agent) throw new NotFoundError('Agent', req.params.id);
    res.json({ success: true, data: agent } as ApiResponse);
    if (req.body.wantText) rescoreInBackground(agent);
  } catch (err) { next(err); }
});

// POST /agents/:id/status — pause, resume, archive.
router.post('/:id/status', authenticate, validate(statusSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.body.status as agentRepo.AgentStatus;
    const agent = await agentRepo.setStatus(req.params.id, req.user!.userId, status);
    if (!agent) throw new NotFoundError('Agent', req.params.id);
    res.json({ success: true, data: agent } as ApiResponse);
    // Resuming re-opens the search; pausing and archiving leave the stored
    // results alone so resuming is instant and nothing is silently destroyed.
    if (status === 'active') rescoreInBackground(agent);
  } catch (err) { next(err); }
});

// POST /agents/:id/interest — "I want to meet" from inside an agent, so the
// introduction carries the reason THIS agent was searching for, and the
// exclusion it creates is scoped to this agent alone (decision D3).
const interestSchema = z.object({ userId: z.string().uuid() });
router.post('/:id/interest', authenticate, validate(interestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await agentRepo.getAgent(req.params.id, req.user!.userId);
    if (!agent) throw new NotFoundError('Agent', req.params.id);
    if (agent.userId === req.body.userId) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot introduce yourself');
    }
    const poke = await platformMatch.expressInterest(req.user!.userId, req.body.userId, agent.id);
    // Drop them from THIS agent's list right away so the count is honest
    // before the next rescore.
    await agentRepo.removeMatch(agent.id, req.body.userId).catch(() => {});
    res.status(201).json({ success: true, data: poke } as ApiResponse);
  } catch (err) { next(err); }
});

export default router;
