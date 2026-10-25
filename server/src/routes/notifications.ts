import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query } from '../db';
import { fanoutOwnNotifications } from '../realtime/fanout';
import { REQUEST_BELL_LINK_PATTERN } from '../services/poke/request-link';
import { ApiResponse } from '@rsn/shared';

const router = Router();

type RequestStatus = 'pending' | 'accepted' | 'declined';

/** One row of the list query: the notification, its invite's state, and its meeting request's. */
interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
  inviteStatus: string | null;
  podId: string | null;
  sessionId: string | null;
  requestStatus: RequestStatus | null;
  requestConversationId: string | null;
}

// GET /notifications — last 20 for current user
// For invite-type notifications, includes invite status so the client knows
// whether to show Accept/Decline buttons.
//
// 25 Oct 2026: the same for a meeting request (`poke` rows). On production Claus
// accepted Stefan's request on the Messages card and the bell entry went on
// offering Accept, because the bell kept the answer only in its own memory and
// this list told it nothing. Each `poke` row now carries, from user_pokes:
//   pokeStatus   'accepted' | 'declined' | null — the field production's bell
//                already draws (null keeps its Accept and Decline);
//   requestState { status, conversationId } | null — for the preview's bell.
// The request is found through the id its link carries (/messages?poke=<id>,
// REQUEST_BELL_LINK_PATTERN): a link that does not hold a whole UUID matches
// nothing and reads null, and only a request sent to the bell's owner counts.
router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query<NotificationRow>(
        `SELECT n.id, n.type, n.title, n.body, n.link, n.is_read AS "isRead", n.created_at AS "createdAt",
                -- Smart invite status: if user is already a member/participant, show as accepted
                -- regardless of raw invite status. Single source of truth.
                CASE
                  WHEN i.id IS NULL THEN NULL
                  WHEN i.status = 'accepted' THEN 'accepted'
                  WHEN i.status = 'revoked' THEN 'revoked'
                  WHEN i.status = 'expired' THEN 'expired'
                  WHEN i.session_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM session_participants sp
                    WHERE sp.session_id = i.session_id AND sp.user_id = $1 AND sp.status != 'removed'
                  ) THEN 'accepted'
                  WHEN i.pod_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM pod_members pm
                    WHERE pm.pod_id = i.pod_id AND pm.user_id = $1
                      -- Bug 30 (19 May Ali) — exclude history rows. A
                      -- 'removed'/'left'/'declined' row means the user is
                      -- NOT currently in the pod, so the new pending
                      -- invite must NOT silently report as 'accepted'.
                      -- Sessions branch above already mirrors this rule.
                      AND pm.status NOT IN ('removed', 'left', 'declined')
                  ) THEN 'accepted'
                  ELSE i.status
                END AS "inviteStatus",
                i.pod_id AS "podId",
                i.session_id AS "sessionId",
                p.status AS "requestStatus",
                rc.id AS "requestConversationId"
         FROM notifications n
         LEFT JOIN invites i ON n.type IN ('pod_invite', 'event_invite')
           AND n.link LIKE '/invite/%'
           AND i.code = SUBSTRING(n.link FROM '/invite/(.+)$')
         -- substring() is NULL when the link does not match, and the pattern only
         -- captures a whole UUID, so the cast never sees anything else.
         LEFT JOIN user_pokes p ON n.type = 'poke'
           AND p.id = substring(n.link FROM $2::text)::uuid
           AND p.recipient_id = n.user_id
         LEFT JOIN LATERAL (
           SELECT c.id FROM dm_conversations c
            WHERE p.status = 'accepted'
              AND ((c.user_a_id = p.sender_id AND c.user_b_id = p.recipient_id)
                OR (c.user_a_id = p.recipient_id AND c.user_b_id = p.sender_id))
            LIMIT 1
         ) rc ON TRUE
         WHERE n.user_id = $1
         ORDER BY n.created_at DESC
         LIMIT 20`,
        [req.user!.userId, REQUEST_BELL_LINK_PATTERN]
      );

      const unreadCount = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
        [req.user!.userId]
      );

      // Only `poke` rows carry the request fields; every other row is sent exactly as before.
      const notifications = result.rows.map(({ requestStatus, requestConversationId, ...row }) => (row.type === 'poke'
        ? {
            ...row,
            pokeStatus: requestStatus === 'accepted' || requestStatus === 'declined' ? requestStatus : null,
            requestState: requestStatus
              ? { status: requestStatus, conversationId: requestStatus === 'accepted' ? requestConversationId : null }
              : null,
          }
        : row));

      const response: ApiResponse = {
        success: true,
        data: {
          notifications,
          unreadCount: parseInt(unreadCount.rows[0]?.count || '0', 10),
        },
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/read-all — mark all as read (MUST be before /:id/read)
router.post(
  '/read-all',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
        [req.user!.userId]
      );
      // Phase May-19 realtime — fan out to the user's own personal
      // room so any other tabs / devices the same user has open reset
      // the bell counter without a refresh.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// POST /notifications/:id/read — mark one as read
router.post(
  '/:id/read',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user!.userId]
      );
      // Phase May-19 realtime — same own-room fanout so cross-tab bell
      // counter stays in sync.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /notifications — clear all notifications for current user
router.delete(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `DELETE FROM notifications WHERE user_id = $1`,
        [req.user!.userId]
      );
      // Phase May-19 realtime — clearing notifications also empties
      // the bell on other tabs.
      fanoutOwnNotifications(req.user!.userId).catch(() => {});
      res.json({ success: true } as ApiResponse);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
