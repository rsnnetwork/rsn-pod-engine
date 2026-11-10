// ─── A member's notifications, newest first, a page at a time (30 Oct 2026 review, item 4.5) ──────────────────────────
//
// Stefan: "Add a place to see all notifications in one list (like Facebook)." GET /notifications answered the newest 20
// and nothing older could be seen anywhere. The list moved here from the route, unchanged in what each row says, and
// now pages: newest first by (created_at, id), each page strictly older than the cursor the last one gave, so a page
// never repeats or skips a row however many share a moment (migration 122 indexes exactly that order).
//
// Each row says where its invite stands, and where its meeting request stands (25 Oct 2026): on production Claus
// accepted Stefan's request on the Messages card and the bell entry went on offering Accept, because the bell kept the
// answer only in its own memory. Each `poke` row carries, from user_pokes:
//   pokeStatus   'accepted' | 'declined' | 'gone' | null — the field production's bell draws (null keeps its Accept and
//                Decline; it draws neither for any other value);
//   requestState { status, conversationId } | null — for the preview's bell, null when the request is gone.
// The request is found through the id its link carries (/messages?poke=<id>, REQUEST_BELL_LINK_PATTERN): a link that
// does not hold a whole UUID matches nothing and reads null, and only a request sent to the bell's owner counts.
// A request still pending that can no longer be answered is 'gone' (26 Oct 2026), by listReceivedPokes' own rule: its
// sender's account is not active, or a block stands between the two, whoever made it. So is one its sender withdrew
// (status 'cancelled', 10 Nov 2026).
//
// Rows carry no actor id (025: a title, a body and a link), so nothing here can say who a row is about; a request or an
// invite from someone removed or blocked is answered by its state ('gone', revoked), which offers nothing to press.

import { query } from '../../db';
import { REQUEST_BELL_LINK_PATTERN } from '../poke/request-link';

/** How many the bell reads: GET /notifications with no query string, exactly as before. */
export const NOTIFICATION_BELL_COUNT = 20;
/** A page of the notifications page, when it asks for none. */
export const NOTIFICATION_PAGE_DEFAULT = 30;
/** The most one page may ask for. */
export const NOTIFICATION_PAGE_MAX = 50;

/** Where a request stands for its recipient; 'gone' is a pending request they can no longer answer. */
type RequestStatus = 'pending' | 'accepted' | 'declined' | 'gone';

/** One row of the list query: the notification, its invite's state, its meeting request's, and where it sorts. */
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
  cursorAt: string;
}

/** Where a page starts: strictly older than this time (to the microsecond, UTC) and id. */
export interface NotificationCursor { at: string; id: string }

export interface NotificationPage {
  notifications: Array<Record<string, unknown>>;
  unreadCount: number;
  /** Pass back as ?before= for the page older than this one; null on the last page. */
  nextBefore: string | null;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opaque cursor a page ends with. */
export function encodeNotificationCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

/** The cursor a client sent back, or null when it is not one this server wrote. */
export function decodeNotificationCursor(cursor: string): NotificationCursor | null {
  const [at, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !at || !id) return null;
  if (!CURSOR_AT.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID.test(id)) return null;
  return { at, id: id.toLowerCase() };
}

/** A page of the member's notifications, newest first, with their unread count. */
export async function listNotifications(
  userId: string,
  options: { before: NotificationCursor | null; limit: number },
): Promise<NotificationPage> {
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
            CASE
              -- 10 Nov 2026: a request its sender withdrew. Its bell row is deleted while unread (withdrawPoke); one
              -- already read stays, and must not offer Accept and Decline on a request that is no longer there.
              WHEN p.status = 'cancelled' THEN 'gone'
              WHEN p.status = 'pending' AND (
                ps.status IS DISTINCT FROM 'active'
                OR EXISTS (
                  SELECT 1 FROM user_blocks b
                   WHERE (b.blocker_id = n.user_id AND b.blocked_id = p.sender_id)
                      OR (b.blocker_id = p.sender_id AND b.blocked_id = n.user_id))
              ) THEN 'gone'
              ELSE p.status
            END AS "requestStatus",
            rc.id AS "requestConversationId",
            -- Where the row sorts, to the microsecond (a JavaScript date keeps milliseconds), for the next page's cursor.
            to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
     FROM notifications n
     LEFT JOIN invites i ON n.type IN ('pod_invite', 'event_invite', 'circle_invite')
       AND n.link LIKE '/invite/%'
       AND i.code = SUBSTRING(n.link FROM '/invite/(.+)$')
     -- substring() is NULL when the link does not match, and the pattern only
     -- captures a whole UUID, so the cast never sees anything else.
     LEFT JOIN user_pokes p ON n.type = 'poke'
       AND p.id = substring(n.link FROM $2::text)::uuid
       AND p.recipient_id = n.user_id
     LEFT JOIN users ps ON ps.id = p.sender_id
     LEFT JOIN LATERAL (
       SELECT c.id FROM dm_conversations c
        WHERE p.status = 'accepted'
          AND ((c.user_a_id = p.sender_id AND c.user_b_id = p.recipient_id)
            OR (c.user_a_id = p.recipient_id AND c.user_b_id = p.sender_id))
        LIMIT 1
     ) rc ON TRUE
     WHERE n.user_id = $1
       AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3::timestamptz, $4::uuid))
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $5`,
    [userId, REQUEST_BELL_LINK_PATTERN, options.before?.at ?? null, options.before?.id ?? null, options.limit + 1],
  );

  const unreadCount = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  );

  const page = result.rows.slice(0, options.limit);
  const last = page[page.length - 1];
  // Only `poke` rows carry the request fields; every other row is sent exactly as before.
  const notifications = page.map(({ requestStatus, requestConversationId, cursorAt: _cursorAt, ...row }) => {
    if (row.type !== 'poke') return row;
    if (requestStatus === 'gone') return { ...row, pokeStatus: 'gone', requestState: null };
    return {
      ...row,
      pokeStatus: requestStatus === 'accepted' || requestStatus === 'declined' ? requestStatus : null,
      requestState: requestStatus
        ? { status: requestStatus, conversationId: requestStatus === 'accepted' ? requestConversationId : null }
        : null,
    };
  });

  return {
    notifications,
    unreadCount: parseInt(unreadCount.rows[0]?.count || '0', 10),
    nextBefore: result.rows.length > options.limit && last ? encodeNotificationCursor(last.cursorAt, last.id) : null,
  };
}
