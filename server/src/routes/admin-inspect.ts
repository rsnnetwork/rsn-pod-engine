// ─── Admin Per-User Inspection Routes (Task E2) ─────────────────────────────
//
// Read-only admin visibility into data that already exists but had no admin
// path: onboarding transcripts + enrichment internals (E1's columns +
// inferred_profile->'enriched'), onboarding stage-event telemetry, member DM
// threads (normally strictly self-scoped — admin intentionally bypasses that
// scoping here, and every thread read is audited), pokes, and reports
// (violations ∪ user_reports, both directions).
//
// Every route: authenticate + requireRole(UserRole.ADMIN). Missing-user 404
// mirrors GET /users/:id (identityService.getUserById throws NotFoundError
// for an unknown id) — same precedent applied here for consistency.

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { query } from '../db';
import { NotFoundError } from '../middleware/errors';
import { ApiResponse, UserRole } from '@rsn/shared';
import * as stageEventsRepo from '../services/onboarding/stage-events.repo';
import * as blockService from '../services/block/block.service';

const router = Router();

async function assertUserExists(userId: string): Promise<void> {
  const r = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [userId]);
  if (r.rows.length === 0) throw new NotFoundError('User', userId);
}

// ─── GET /users/:id/onboarding ───────────────────────────────────────────────
// Internal (admin) view — unlike GET /onboarding/status this DOES surface
// enrichment.source and enrichment.error; those are deliberately withheld
// from the member-facing payload but are exactly what the admin inspector
// needs to diagnose a stuck/failed enrichment.

router.get(
  '/users/:id/onboarding',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.params.id;
      await assertUserExists(userId);

      const [joined, stageEvents] = await Promise.all([
        query<{
          linkedin_url: string | null;
          onboarding_status: string;
          last_onboarded_at: Date | null;
          enrichment_status: string | null;
          enrichment_source: string | null;
          enrichment_error: string | null;
          enrichment_started_at: Date | null;
          enrichment_completed_at: Date | null;
          enrichment_result: unknown;
          onboarding_conversation: unknown[] | null;
          matching_intent: unknown;
          matching_tags: string[] | null;
          avoid_preferences: string[] | null;
          profile_strength: string | null;
          confidence: unknown;
        }>(
          `SELECT u.linkedin_url, u.onboarding_status, u.last_onboarded_at,
                  uip.enrichment_status, uip.enrichment_source, uip.enrichment_error,
                  uip.enrichment_started_at, uip.enrichment_completed_at,
                  uip.inferred_profile->'enriched' AS enrichment_result,
                  uip.onboarding_conversation, uip.matching_intent, uip.matching_tags,
                  uip.avoid_preferences, uip.profile_strength, uip.confidence
             FROM users u
             LEFT JOIN user_intent_profiles uip ON uip.user_id = u.id
            WHERE u.id = $1`,
          [userId],
        ),
        stageEventsRepo.listForUser(userId),
      ]);

      if (joined.rows.length === 0) {
        return next(new NotFoundError('User', userId));
      }
      const r = joined.rows[0];

      const data = {
        linkedinUrl: r.linkedin_url,
        onboardingStatus: r.onboarding_status,
        lastOnboardedAt: r.last_onboarded_at,
        enrichment: {
          status: r.enrichment_status ?? 'none',
          source: r.enrichment_source ?? null,
          error: r.enrichment_error ?? null,
          startedAt: r.enrichment_started_at ?? null,
          completedAt: r.enrichment_completed_at ?? null,
          result: r.enrichment_result ?? null,
        },
        conversation: r.onboarding_conversation ?? [],
        intent: {
          matchingIntent: r.matching_intent ?? {},
          tags: r.matching_tags ?? [],
          avoidPreferences: r.avoid_preferences ?? [],
          profileStrength: r.profile_strength ?? null,
          confidence: r.confidence ?? {},
        },
        stageEvents,
      };

      const response: ApiResponse = { success: true, data };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  },
);

// ─── GET /users/:id/conversations ────────────────────────────────────────────
// Both directions (user_a or user_b), soft-deleted threads INCLUDED (flagged
// via deletedAt) — unlike the member-facing dm.service.listConversations,
// which filters soft-deleted rows out. The admin inspector needs to see the
// whole history, not just what the member currently sees in their inbox.

router.get(
  '/users/:id/conversations',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.params.id;
      await assertUserExists(userId);

      const result = await query<{
        conversation_id: string;
        partner_id: string;
        partner_display_name: string | null;
        partner_avatar_url: string | null;
        last_message_at: Date | null;
        meeting_confirmed_window: string | null;
        deleted_at: Date | null;
        message_count: string;
      }>(
        `SELECT
            c.id AS conversation_id,
            CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS partner_id,
            u.display_name AS partner_display_name,
            u.avatar_url AS partner_avatar_url,
            c.last_message_at,
            c.meeting_confirmed_window,
            CASE WHEN c.user_a_id = $1 THEN c.user_a_deleted_at ELSE c.user_b_deleted_at END AS deleted_at,
            (SELECT COUNT(*)::text FROM direct_messages dm WHERE dm.conversation_id = c.id) AS message_count
         FROM dm_conversations c
         JOIN users u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
         WHERE c.user_a_id = $1 OR c.user_b_id = $1
         ORDER BY c.last_message_at DESC NULLS LAST`,
        [userId],
      );

      const data = result.rows.map((row) => ({
        conversationId: row.conversation_id,
        partner: {
          id: row.partner_id,
          displayName: row.partner_display_name,
          avatarUrl: row.partner_avatar_url,
        },
        lastMessageAt: row.last_message_at,
        messageCount: parseInt(row.message_count, 10),
        meetingConfirmedWindow: row.meeting_confirmed_window,
        deletedAt: row.deleted_at,
      }));

      const response: ApiResponse = { success: true, data };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  },
);

// ─── GET /conversations/:id/messages ─────────────────────────────────────────
// Every successful read is audited — INSERT INTO audit_log is awaited
// directly in this handler (NOT the fire-and-forget recordAudit() helper
// audit.ts's auditMiddleware uses elsewhere, which swallows insert failures).
// The audit insert runs BEFORE the messages are fetched: if it throws, the
// catch below hands the error to the global errorHandler (500, no data) and
// the message read never happens. An unauditable read must not succeed.

router.get(
  '/conversations/:id/messages',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversationId = req.params.id;

      const convCheck = await query<{ id: string }>(
        `SELECT id FROM dm_conversations WHERE id = $1`,
        [conversationId],
      );
      if (convCheck.rows.length === 0) {
        return next(new NotFoundError('Conversation', conversationId));
      }

      await query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user!.userId, 'admin_read_dm', 'dm_conversation', conversationId, JSON.stringify({}), req.ip || null],
      );

      const messages = await query<{
        id: string;
        from_user_id: string;
        content: string | null;
        attachment_url: string | null;
        created_at: Date;
      }>(
        `SELECT id, from_user_id, content, attachment_url, created_at
           FROM direct_messages
          WHERE conversation_id = $1
          ORDER BY created_at ASC`,
        [conversationId],
      );

      const data = messages.rows.map((m) => ({
        id: m.id,
        fromUserId: m.from_user_id,
        content: m.content,
        attachmentUrl: m.attachment_url,
        createdAt: m.created_at,
      }));

      const response: ApiResponse = { success: true, data };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  },
);

// ─── GET /users/:id/interactions ─────────────────────────────────────────────
// pokes (both directions), reports (violations ∪ user_reports, both
// directions, sourced with a `source` discriminator), and blocks (given +
// received).

interface PokeRow {
  id: string;
  other_id: string;
  other_display_name: string | null;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  created_at: Date;
  responded_at: Date | null;
}

function mapPokeRow(r: PokeRow) {
  return {
    id: r.id,
    otherUser: { id: r.other_id, displayName: r.other_display_name },
    status: r.status,
    message: r.message,
    createdAt: r.created_at,
    respondedAt: r.responded_at,
  };
}

router.get(
  '/users/:id/interactions',
  authenticate,
  requireRole(UserRole.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.params.id;
      await assertUserExists(userId);

      const [pokesSentResult, pokesReceivedResult, reportsResult, blocksGiven, blocksReceivedResult] =
        await Promise.all([
          query<PokeRow>(
            `SELECT p.id, p.recipient_id AS other_id, u.display_name AS other_display_name,
                    p.status, p.message, p.created_at, p.responded_at
               FROM user_pokes p
               JOIN users u ON u.id = p.recipient_id
              WHERE p.sender_id = $1
              ORDER BY p.created_at DESC`,
            [userId],
          ),
          query<PokeRow>(
            `SELECT p.id, p.sender_id AS other_id, u.display_name AS other_display_name,
                    p.status, p.message, p.created_at, p.responded_at
               FROM user_pokes p
               JOIN users u ON u.id = p.sender_id
              WHERE p.recipient_id = $1
              ORDER BY p.created_at DESC`,
            [userId],
          ),
          query<{
            source: 'violation' | 'user_report';
            id: string;
            reporter_id: string | null;
            reported_id: string;
            reason: string;
            status: string;
            resolution_notes: string | null;
            resolved_by: string | null;
            resolved_at: Date | null;
            created_at: Date;
            detail_text: string | null;
          }>(
            `SELECT * FROM (
               SELECT 'violation'::text AS source, id, reporter_id, reported_user_id AS reported_id,
                      reason, status::text AS status, admin_notes AS resolution_notes,
                      resolved_by, resolved_at, created_at, details AS detail_text
                 FROM violations
                WHERE reporter_id = $1 OR reported_user_id = $1
               UNION ALL
               SELECT 'user_report'::text AS source, id, reporter_id, reported_id,
                      reason, status::text AS status, resolution_notes,
                      resolved_by, resolved_at, created_at, description AS detail_text
                 FROM user_reports
                WHERE reporter_id = $1 OR reported_id = $1
             ) combined
             ORDER BY created_at DESC`,
            [userId],
          ),
          blockService.listBlocked(userId),
          query<{
            blocker_id: string;
            display_name: string | null;
            avatar_url: string | null;
            reason: string | null;
            created_at: Date;
          }>(
            `SELECT ub.blocker_id, u.display_name, u.avatar_url, ub.reason, ub.created_at
               FROM user_blocks ub
               JOIN users u ON u.id = ub.blocker_id
              WHERE ub.blocked_id = $1
              ORDER BY ub.created_at DESC`,
            [userId],
          ),
        ]);

      const data = {
        pokesSent: pokesSentResult.rows.map(mapPokeRow),
        pokesReceived: pokesReceivedResult.rows.map(mapPokeRow),
        reports: reportsResult.rows.map((r) => ({
          source: r.source,
          reporterId: r.reporter_id,
          reportedId: r.reported_id,
          reason: r.reason,
          status: r.status,
          resolvedBy: r.resolved_by,
          resolvedAt: r.resolved_at,
          resolutionNotes: r.resolution_notes,
          createdAt: r.created_at,
          detailText: r.detail_text ?? null,
        })),
        blocks: {
          given: blocksGiven,
          received: blocksReceivedResult.rows.map((r) => ({
            blockerId: r.blocker_id,
            displayName: r.display_name,
            avatarUrl: r.avatar_url,
            reason: r.reason,
            createdAt: r.created_at,
          })),
        },
      };

      const response: ApiResponse = { success: true, data };
      return res.json(response);
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
