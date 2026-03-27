// ─── Admin Routes ────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { query } from '../db';
import { ApiResponse, UserRole } from '@rsn/shared';

const router = Router();

// ─── GET /admin/stats ────────────────────────────────────────────────────────

router.get(
  '/stats',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Run all counts in parallel
      const [
        usersResult,
        activeUsersResult,
        podsResult,
        activePodsResult,
        eventsResult,
        completedEventsResult,
        matchesResult,
        avgRatingResult,
        growthResult,
      ] = await Promise.all([
        query<{ count: string }>(`SELECT COUNT(*) as count FROM users`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM users WHERE last_active_at > NOW() - INTERVAL '7 days'`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM pods`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM pods WHERE status = 'active'`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM sessions`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM sessions WHERE status = 'completed'`),
        query<{ count: string }>(`SELECT COUNT(*) as count FROM matches`),
        query<{ avg: string | null }>(`SELECT ROUND(AVG(quality_score), 1) as avg FROM ratings WHERE quality_score IS NOT NULL`),
        query<{ date: string; count: string }>(
          `SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') as date, COUNT(*) as count
           FROM users
           WHERE created_at > NOW() - INTERVAL '30 days'
           GROUP BY created_at::date
           ORDER BY date`
        ),
      ]);

      const stats = {
        totalUsers: parseInt(usersResult.rows[0].count, 10),
        activeUsers7d: parseInt(activeUsersResult.rows[0].count, 10),
        totalPods: parseInt(podsResult.rows[0].count, 10),
        activePods: parseInt(activePodsResult.rows[0].count, 10),
        totalEvents: parseInt(eventsResult.rows[0].count, 10),
        completedEvents: parseInt(completedEventsResult.rows[0].count, 10),
        totalMatches: parseInt(matchesResult.rows[0].count, 10),
        avgRating: avgRatingResult.rows[0].avg ? parseFloat(avgRatingResult.rows[0].avg) : null,
        userGrowth: growthResult.rows.map(r => ({ date: r.date, count: parseInt(r.count, 10) })),
      };

      const response: ApiResponse = { success: true, data: stats };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /admin/users/:id/entitlements ───────────────────────────────────────

router.get(
  '/users/:id/entitlements',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `SELECT id, user_id AS "userId",
                max_pods_owned AS "maxPodsOwned", max_sessions_per_month AS "maxSessionsPerMonth",
                max_invites_per_day AS "maxInvitesPerDay", can_host_sessions AS "canHostSessions",
                can_create_pods AS "canCreatePods", access_level AS "accessLevel", overrides
         FROM user_entitlements WHERE user_id = $1`,
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: { message: 'No entitlements found for user' } });
      }
      const response: ApiResponse = { success: true, data: result.rows[0] };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── PUT /admin/users/:id/entitlements ───────────────────────────────────────

const updateEntitlementsSchema = z.object({
  maxPodsOwned: z.number().int().min(0).max(100).optional(),
  maxSessionsPerMonth: z.number().int().min(0).max(500).optional(),
  maxInvitesPerDay: z.number().int().min(0).max(1000).optional(),
  canHostSessions: z.boolean().optional(),
  canCreatePods: z.boolean().optional(),
  accessLevel: z.string().max(50).optional(),
});

router.put(
  '/users/:id/entitlements',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(updateEntitlementsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fieldMap: Record<string, string> = {
        maxPodsOwned: 'max_pods_owned',
        maxSessionsPerMonth: 'max_sessions_per_month',
        maxInvitesPerDay: 'max_invites_per_day',
        canHostSessions: 'can_host_sessions',
        canCreatePods: 'can_create_pods',
        accessLevel: 'access_level',
      };

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const [key, col] of Object.entries(fieldMap)) {
        if (key in req.body) {
          setClauses.push(`${col} = $${idx}`);
          values.push(req.body[key]);
          idx++;
        }
      }

      if (setClauses.length === 0) {
        return res.json({ success: true, data: {} });
      }

      setClauses.push(`updated_at = NOW()`);
      values.push(req.params.id);

      await query(
        `UPDATE user_entitlements SET ${setClauses.join(', ')} WHERE user_id = $${idx}`,
        values
      );

      // Return updated entitlements
      const result = await query(
        `SELECT id, user_id AS "userId",
                max_pods_owned AS "maxPodsOwned", max_sessions_per_month AS "maxSessionsPerMonth",
                max_invites_per_day AS "maxInvitesPerDay", can_host_sessions AS "canHostSessions",
                can_create_pods AS "canCreatePods", access_level AS "accessLevel", overrides
         FROM user_entitlements WHERE user_id = $1`,
        [req.params.id]
      );
      const response: ApiResponse = { success: true, data: result.rows[0] };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── POST /admin/users/bulk-action ───────────────────────────────────────────

const bulkUserActionSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['suspend', 'ban', 'activate', 'delete', 'change_role']),
  value: z.string().optional(),
});

router.post(
  '/users/bulk-action',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(bulkUserActionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userIds, action, value } = req.body;

      if (action === 'change_role') {
        if (!value || !['member', 'admin', 'super_admin'].includes(value)) {
          return res.status(400).json({ success: false, error: { message: 'Invalid role' } });
        }
        const result = await query(
          `UPDATE users SET role = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
          [value, userIds]
        );
        const response: ApiResponse = { success: true, data: { affected: result.rowCount } };
        return res.json(response);
      }

      let statusUpdate: string;
      switch (action) {
        case 'suspend': statusUpdate = 'suspended'; break;
        case 'ban': statusUpdate = 'banned'; break;
        case 'activate': statusUpdate = 'active'; break;
        case 'delete': statusUpdate = 'deactivated'; break;
        default: return res.status(400).json({ success: false, error: { message: 'Invalid action' } });
      }

      const result = await query(
        `UPDATE users SET status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
        [statusUpdate, userIds]
      );

      const response: ApiResponse = { success: true, data: { affected: result.rowCount } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ─── POST /admin/join-requests/bulk-action ───────────────────────────────────

const bulkJoinRequestActionSchema = z.object({
  requestIds: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['approve', 'decline']),
  notes: z.string().max(500).optional(),
});

router.post(
  '/join-requests/bulk-action',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(bulkJoinRequestActionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requestIds, action, notes } = req.body;
      const status = action === 'approve' ? 'approved' : 'declined';

      const result = await query(
        `UPDATE join_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW(), admin_notes = $3, updated_at = NOW()
         WHERE id = ANY($4::uuid[]) AND status = 'pending'
         RETURNING id`,
        [status, req.user!.userId, notes || null, requestIds]
      );

      const response: ApiResponse = { success: true, data: { affected: result.rowCount } };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// VIOLATIONS / MODERATION
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/violations
router.get(
  '/violations',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = (req.query.status as string) || 'open';
      const result = await query(
        `SELECT v.id, v.reason, v.details, v.status, v.admin_notes AS "adminNotes",
                v.created_at AS "createdAt", v.resolved_at AS "resolvedAt",
                reporter.display_name AS "reporterName", reporter.email AS "reporterEmail",
                reported.display_name AS "reportedName", reported.email AS "reportedEmail",
                reported.id AS "reportedUserId",
                resolver.display_name AS "resolverName"
         FROM violations v
         LEFT JOIN users reporter ON reporter.id = v.reporter_id
         JOIN users reported ON reported.id = v.reported_user_id
         LEFT JOIN users resolver ON resolver.id = v.resolved_by
         WHERE ($1 = '' OR v.status = $1::violation_status)
         ORDER BY v.created_at DESC
         LIMIT 100`,
        [status]
      );
      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/violations/:id/resolve
const resolveViolationSchema = z.object({
  action: z.enum(['dismiss', 'warn', 'suspend', 'ban']),
  adminNotes: z.string().max(2000).optional(),
});

router.post(
  '/violations/:id/resolve',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(resolveViolationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { action, adminNotes } = req.body;
      const newStatus = action === 'dismiss' ? 'dismissed' : 'actioned';

      await query(
        `UPDATE violations SET status = $1, admin_notes = $2, resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
         WHERE id = $4`,
        [newStatus, adminNotes || null, req.user!.userId, req.params.id]
      );

      // If action is suspend or ban, update the user's status
      if (action === 'suspend' || action === 'ban') {
        const violation = await query<{ reported_user_id: string }>(
          `SELECT reported_user_id FROM violations WHERE id = $1`, [req.params.id]
        );
        if (violation.rows[0]) {
          const userStatus = action === 'suspend' ? 'suspended' : 'banned';
          await query(`UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2`, [userStatus, violation.rows[0].reported_user_id]);
        }
      }

      const response: ApiResponse = { success: true, data: { message: `Violation ${newStatus}` } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /violations/report (any authenticated user can report)
const reportSchema = z.object({
  reportedUserId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  details: z.string().max(2000).optional(),
});

router.post(
  '/violations/report',
  authenticate,
  validate(reportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportedUserId, reason, details } = req.body;
      await query(
        `INSERT INTO violations (reporter_id, reported_user_id, reason, details)
         VALUES ($1, $2, $3, $4)`,
        [req.user!.userId, reportedUserId, reason, details || null]
      );
      const response: ApiResponse = { success: true, data: { message: 'Report submitted' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// MATCHING TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/templates
router.get(
  '/templates',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `SELECT id, name, description, is_default AS "isDefault",
                weight_industry AS "weightIndustry", weight_interests AS "weightInterests",
                weight_intent AS "weightIntent", weight_experience AS "weightExperience",
                weight_location AS "weightLocation",
                rematch_cooldown_rounds AS "rematchCooldownRounds",
                exploration_level AS "explorationLevel",
                same_company_allowed AS "sameCompanyAllowed",
                fallback_strategy AS "fallbackStrategy",
                created_at AS "createdAt"
         FROM matching_templates ORDER BY is_default DESC, created_at DESC`
      );
      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/templates
const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  weightIndustry: z.number().min(0).max(1).optional(),
  weightInterests: z.number().min(0).max(1).optional(),
  weightIntent: z.number().min(0).max(1).optional(),
  weightExperience: z.number().min(0).max(1).optional(),
  weightLocation: z.number().min(0).max(1).optional(),
  rematchCooldownRounds: z.number().int().min(0).max(50).optional(),
  explorationLevel: z.number().min(0).max(1).optional(),
  sameCompanyAllowed: z.boolean().optional(),
  fallbackStrategy: z.string().max(50).optional(),
});

router.post(
  '/templates',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(createTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body;
      const result = await query(
        `INSERT INTO matching_templates (name, description, weight_industry, weight_interests, weight_intent,
         weight_experience, weight_location, rematch_cooldown_rounds, exploration_level,
         same_company_allowed, fallback_strategy, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [b.name, b.description || null, b.weightIndustry ?? 0.3, b.weightInterests ?? 0.3,
         b.weightIntent ?? 0.2, b.weightExperience ?? 0.1, b.weightLocation ?? 0.1,
         b.rematchCooldownRounds ?? 3, b.explorationLevel ?? 0.2,
         b.sameCompanyAllowed ?? false, b.fallbackStrategy ?? 'random', req.user!.userId]
      );
      const response: ApiResponse = { success: true, data: result.rows[0] };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /admin/templates/:id
router.put(
  '/templates/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(createTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body;
      await query(
        `UPDATE matching_templates SET name=$1, description=$2, weight_industry=$3, weight_interests=$4,
         weight_intent=$5, weight_experience=$6, weight_location=$7, rematch_cooldown_rounds=$8,
         exploration_level=$9, same_company_allowed=$10, fallback_strategy=$11, updated_at=NOW()
         WHERE id=$12`,
        [b.name, b.description || null, b.weightIndustry ?? 0.3, b.weightInterests ?? 0.3,
         b.weightIntent ?? 0.2, b.weightExperience ?? 0.1, b.weightLocation ?? 0.1,
         b.rematchCooldownRounds ?? 3, b.explorationLevel ?? 0.2,
         b.sameCompanyAllowed ?? false, b.fallbackStrategy ?? 'random', req.params.id]
      );
      const response: ApiResponse = { success: true, data: { message: 'Template updated' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /admin/templates/:id
router.delete(
  '/templates/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(`DELETE FROM matching_templates WHERE id = $1 AND is_default = FALSE`, [req.params.id]);
      const response: ApiResponse = { success: true, data: { message: 'Template deleted' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/email-config
router.get(
  '/email-config',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `SELECT id, email_type AS "emailType", enabled, subject, updated_at AS "updatedAt"
         FROM email_config ORDER BY email_type`
      );
      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /admin/email-config/:id
const updateEmailConfigSchema = z.object({
  enabled: z.boolean(),
});

router.put(
  '/email-config/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(updateEmailConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE email_config SET enabled = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`,
        [req.body.enabled, req.user!.userId, req.params.id]
      );
      const response: ApiResponse = { success: true, data: { message: 'Email config updated' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/support-tickets
router.get(
  '/support-tickets',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = (req.query.status as string) || '';
      const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
      const pageSize = 20;
      const offset = (page - 1) * pageSize;

      const whereClause = status ? `WHERE st.status = $1` : '';
      const params = status ? [status, pageSize, offset] : [pageSize, offset];
      const countParams = status ? [status] : [];

      const [ticketsResult, countResult] = await Promise.all([
        query(
          `SELECT st.id, st.subject, st.message, st.status, st.admin_notes AS "adminNotes",
                  st.created_at AS "createdAt", st.updated_at AS "updatedAt",
                  u.display_name AS "userName", u.email AS "userEmail", u.avatar_url AS "userAvatarUrl",
                  a.display_name AS "assignedToName"
           FROM support_tickets st
           JOIN users u ON u.id = st.user_id
           LEFT JOIN users a ON a.id = st.assigned_to
           ${whereClause}
           ORDER BY CASE st.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END, st.created_at DESC
           LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
          params
        ),
        query(`SELECT COUNT(*) as count FROM support_tickets st ${whereClause}`, countParams),
      ]);

      const total = parseInt(countResult.rows[0].count as string, 10);
      const response: ApiResponse = {
        success: true,
        data: ticketsResult.rows,
        meta: { page, pageSize, totalCount: total, totalPages: Math.ceil(total / pageSize), hasPrev: page > 1, hasNext: page * pageSize < total },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /admin/support-tickets/:id
const updateTicketSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  adminNotes: z.string().max(5000).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});

router.patch(
  '/support-tickets/:id',
  authenticate,
  requireRole(UserRole.ADMIN),
  validate(updateTicketSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const setClauses: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [];
      let idx = 1;

      if (req.body.status !== undefined) {
        setClauses.push(`status = $${idx}`); values.push(req.body.status); idx++;
      }
      if (req.body.adminNotes !== undefined) {
        setClauses.push(`admin_notes = $${idx}`); values.push(req.body.adminNotes); idx++;
      }
      if (req.body.assignedTo !== undefined) {
        setClauses.push(`assigned_to = $${idx}`); values.push(req.body.assignedTo); idx++;
      }

      values.push(req.params.id);
      await query(`UPDATE support_tickets SET ${setClauses.join(', ')} WHERE id = $${idx}`, values);

      const response: ApiResponse = { success: true, data: { message: 'Ticket updated' } };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /support-tickets (any authenticated user)
const createTicketSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
});

router.post(
  '/support-tickets',
  authenticate,
  validate(createTicketSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subject, message } = req.body;
      const result = await query(
        `INSERT INTO support_tickets (user_id, subject, message) VALUES ($1, $2, $3) RETURNING id`,
        [req.user!.userId, subject, message]
      );
      const response: ApiResponse = { success: true, data: result.rows[0] };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// GET /support-tickets/mine (user's own tickets)
router.get(
  '/support-tickets/mine',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `SELECT id, subject, status, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.user!.userId]
      );
      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT MATCHES (admin view with user details)
// ═══════════════════════════════════════════════════════════════════════════════

router.get(
  '/matches',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
      const result = await query(
        `SELECT m.id, m.round_number AS "roundNumber", m.status, m.score,
                m.started_at AS "startedAt", m.ended_at AS "endedAt", m.created_at AS "createdAt",
                s.title AS "sessionTitle", s.scheduled_at AS "sessionDate",
                ua.display_name AS "participantAName", ua.email AS "participantAEmail",
                ua.avatar_url AS "participantAAvatarUrl", ua.id AS "participantAId",
                ub.display_name AS "participantBName", ub.email AS "participantBEmail",
                ub.avatar_url AS "participantBAvatarUrl", ub.id AS "participantBId",
                uc.display_name AS "participantCName", uc.email AS "participantCEmail",
                uc.avatar_url AS "participantCAvatarUrl", uc.id AS "participantCId"
         FROM matches m
         JOIN sessions s ON s.id = m.session_id
         JOIN users ua ON ua.id = m.participant_a_id
         JOIN users ub ON ub.id = m.participant_b_id
         LEFT JOIN users uc ON uc.id = m.participant_c_id
         ORDER BY m.created_at DESC
         LIMIT $1`,
        [limit]
      );
      const response: ApiResponse = { success: true, data: result.rows };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
