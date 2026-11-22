// ─── One door for member notification emails (22 Nov 2026, Stefan) ───────────────────────────────────────────
//
// "I should only get notifications if I am not online on the platform", "max X notifications a day, and if more than
// X, then send a mail the next day on what happened on REASON" (X = 3). Every member notification email (a meeting
// request received, a meeting request accepted, a direct message, an invite to a pod, event or circle for someone who
// already has an account) is handed to queueNotificationEmail instead of being sent. notification-email.rules.ts holds
// the rules; this file reads and writes the rows and sends.
//
//   queue  — one row in notification_email_outbox (migration 160), due in AWAY_DELAY_MINUTES when the member is to be
//            emailed only while away, at once otherwise. One row per member, kind and source, so a retry never queues
//            twice. A member who gets no such email (a guest, a closed account, email switched off, that kind switched
//            off) gets no row.
//   flush  — every minute (index.ts) and at once for a member who is emailed right away: each member with a row due
//            has ALL their queued rows decided together (planFlush). Let go: what they have read, or seen by being on
//            REASON since. Held: what is over today's maximum, for tomorrow's "Yesterday on REASON"
//            (notification-digest.service.ts). The rest goes as ONE email: the notification's own email when there is
//            one thing, a round-up ("3 new messages and 1 meeting request") when there are several.
//
// Several instances: a member is flushed by one instance at a time (a transaction-scoped advisory lock on the member,
// tried, never waited for), the rows are re-read under FOR UPDATE inside it, and the day's count is read under the same
// lock, so two instances can neither send the same row nor both send the member's last email of the day. A row is sent
// at most once: a send that fails is marked failed, never retried; a row left "sending" by an instance that died is
// marked failed after STUCK_MINUTES.
//
// NOTIFICATION_EMAIL_GATE=off (config.notificationEmailGate) sends each one at once, as before the gate.

import config from '../../config';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import * as emailService from '../email/email.service';
import { prefsFromStored, type NotificationPrefs } from '../notification-prefs/notification-prefs.service';
import { presenceState } from '../presence/presence.service';
import {
  type NotificationEmailRequest, type OutboxItem, type PlannedItem, type FlushPlan, type LetGoReason,
  emailTypeOf, memberGetsNotificationEmails, planFlush, prefCategoryOf, sectionsOf, sendAfterFor, summaryLine,
} from './notification-email.rules';

/** A row left "sending" this long by an instance that stopped is given up on (marked failed, never sent twice). */
export const STUCK_MINUTES = 30;
/** Members flushed per run, and rows read per member. */
const MEMBERS_PER_RUN = 50;
const ROWS_PER_MEMBER = 100;
/** The first key of the two-key advisory lock a member's flush takes ("rsn:notification-email" as a number). */
export const FLUSH_LOCK_SPACE = 74_160_160;

/**
 * The member's own time zone as SQL, for `NOW() AT TIME ZONE`: users.timezone when Postgres knows the name, else UTC.
 * users.timezone was never checked on the profile form, so it can hold anything; an unknown name would make AT TIME
 * ZONE fail the whole statement. `alias` is a users alias from the statement's own text, never input.
 */
export function memberZoneSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Not a table alias: ${alias}`);
  return `(CASE WHEN ${alias}.timezone IN (SELECT name FROM pg_timezone_names) THEN ${alias}.timezone ELSE 'UTC' END)`;
}

/** The member as the gate reads them. */
export interface GateMemberRow {
  id: string;
  email: string | null;
  display_name: string | null;
  first_name: string | null;
  status: string;
  account_kind: string;
  notify_email: boolean;
  notification_prefs: unknown;
  last_seen_at: Date | null;
  /** Their own calendar day now, YYYY-MM-DD. */
  local_day: string;
}

export async function loadGateMember(userId: string, now: Date = new Date()): Promise<GateMemberRow | null> {
  const r = await query<GateMemberRow>(
    `SELECT u.id, u.email, u.display_name, u.first_name, u.status, u.account_kind, u.notify_email,
            u.notification_prefs, u.last_seen_at,
            to_char(($2::timestamptz AT TIME ZONE ${memberZoneSql('u')})::date, 'YYYY-MM-DD') AS local_day
       FROM users u WHERE u.id = $1`,
    [userId, now],
  );
  return r.rows[0] ?? null;
}

const gateMemberOf = (m: GateMemberRow) => ({
  email: m.email, status: m.status, accountKind: m.account_kind, notifyEmail: m.notify_email,
});

/** What an email greets the member as. */
export function greetingName(m: Pick<GateMemberRow, 'display_name' | 'first_name'>): string {
  return m.first_name?.trim() || m.display_name?.trim() || 'there';
}

/** Whether this kind of email is switched on for this member: their Settings switch and the admin's. */
async function switchedOn(prefs: NotificationPrefs, kind: NotificationEmailRequest['kind'], typeCache: Map<string, boolean>): Promise<boolean> {
  if (!prefs[`${prefCategoryOf(kind)}_email`]) return false;
  const type = emailTypeOf(kind);
  if (!type) return true;
  if (!typeCache.has(type)) typeCache.set(type, await emailService.isEmailTypeEnabled(type));
  return typeCache.get(type) === true;
}

/**
 * Hand a member notification email to the gate. Never throws and never waits on a send: whatever goes wrong is logged,
 * and the notification itself (the bell, the message, the request) has already happened.
 */
export async function queueNotificationEmail(request: NotificationEmailRequest, now: Date = new Date()): Promise<void> {
  try {
    if (config.notificationEmailGate === 'off') {
      await sendWithoutGate(request);
      return;
    }
    const member = await loadGateMember(request.userId, now);
    if (!member || !memberGetsNotificationEmails(gateMemberOf(member))) return;
    const prefs = prefsFromStored(member.notification_prefs);
    if (!(await switchedOn(prefs, request.kind, new Map()))) return;
    const sendAfter = sendAfterFor(now, prefs.email_away_only);
    const inserted = await query<{ id: string }>(
      `INSERT INTO notification_email_outbox (user_id, kind, source_id, actor_id, bell_link, payload, send_after, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, kind, source_id) DO NOTHING
       RETURNING id`,
      [request.userId, request.kind, request.sourceId, request.actorId ?? null, request.bellLink ?? null,
        JSON.stringify(request.payload), sendAfter, now],
    );
    if (inserted.rows.length > 0 && !prefs.email_away_only) {
      // "Only email me when I'm away" is off: it goes now, not at the next minute's run.
      setImmediate(() => {
        flushMember(request.userId).catch((err) => logger.warn({ err, userId: request.userId }, 'immediate notification email flush failed'));
      });
    }
  } catch (err) {
    logger.warn({ err, userId: request.userId, kind: request.kind }, 'notification email not queued (non-fatal)');
  }
}

// ── Reading the rows back ────────────────────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  kind: OutboxItem['kind'];
  source_id: string;
  actor_id: string | null;
  bell_link: string | null;
  payload: unknown;
  created_at: Date;
  send_after: Date;
}

export const OUTBOX_COLUMNS = 'id, kind, source_id, actor_id, bell_link, payload, created_at, send_after';

export type StoredItem = OutboxItem & { bellLink: string | null };

export function itemOf(row: OutboxRow): StoredItem {
  const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as OutboxItem['payload'];
  return {
    id: row.id, kind: row.kind, payload, sourceId: row.source_id, actorId: row.actor_id, bellLink: row.bell_link,
    createdAt: new Date(row.created_at), sendAfter: new Date(row.send_after),
  } as StoredItem;
}

/**
 * Which of these are still news for the member: nothing they have read or answered. A bell row on the same link the
 * member has read since the item was written means they opened it; a request is news while it waits for an answer
 * from someone still active; an acceptance while it stands; a message while it is unread in a conversation they keep;
 * an invite while it is pending, unexpired, and its sender may still reach them. A question that fails counts the item
 * as no longer news: no email rather than a wrong one.
 */
export async function stillNews(userId: string, memberEmail: string | null, items: StoredItem[]): Promise<Set<string>> {
  const news = new Set<string>();
  if (items.length === 0) return news;
  try {
    const links = [...new Set(items.map((i) => i.bellLink).filter((l): l is string => !!l))];
    const readBells = links.length === 0 ? [] : (await query<{ link: string; created_at: Date }>(
      `SELECT link, created_at FROM notifications
        WHERE user_id = $1 AND is_read = TRUE AND link = ANY($2::text[]) AND created_at >= $3`,
      [userId, links, new Date(Math.min(...items.map((i) => i.createdAt.getTime())) - 60_000)],
    )).rows;
    const bellRead = (item: StoredItem) => !!item.bellLink && readBells.some((b) =>
      b.link === item.bellLink && new Date(b.created_at).getTime() >= item.createdAt.getTime() - 60_000);

    const ids = (kind: OutboxItem['kind']) => items.filter((i) => i.kind === kind).map((i) => i.sourceId);
    const standing = new Set<string>();
    const requests = ids('meeting_request');
    if (requests.length > 0) {
      (await query<{ id: string }>(
        `SELECT p.id FROM user_pokes p JOIN users s ON s.id = p.sender_id
          WHERE p.id = ANY($1::uuid[]) AND p.recipient_id = $2 AND p.status = 'pending' AND s.status = 'active'`,
        [requests, userId],
      )).rows.forEach((r) => standing.add(r.id));
    }
    const accepted = ids('meeting_accepted');
    if (accepted.length > 0) {
      (await query<{ id: string }>(
        `SELECT id FROM user_pokes WHERE id = ANY($1::uuid[]) AND sender_id = $2 AND status = 'accepted'`,
        [accepted, userId],
      )).rows.forEach((r) => standing.add(r.id));
    }
    const messages = ids('direct_message');
    if (messages.length > 0) {
      (await query<{ id: string }>(
        `SELECT dm.id FROM direct_messages dm JOIN dm_conversations c ON c.id = dm.conversation_id
          WHERE dm.id = ANY($1::uuid[]) AND dm.read_at IS NULL AND dm.from_user_id <> $2
            AND ((c.user_a_id = $2 AND c.user_a_deleted_at IS NULL) OR (c.user_b_id = $2 AND c.user_b_deleted_at IS NULL))`,
        [messages, userId],
      )).rows.forEach((r) => standing.add(r.id));
    }
    const invites = ids('invite');
    if (invites.length > 0) {
      const pending = (await query<{ id: string; inviter_id: string }>(
        `SELECT id, inviter_id FROM invites
          WHERE id = ANY($1::uuid[]) AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())`,
        [invites],
      )).rows;
      if (pending.length > 0 && memberEmail) {
        const inviteService = await import('../invite/invite.service');
        for (const inv of pending) {
          if ((await inviteService.unreachableAddresses(inv.inviter_id, [memberEmail])).size === 0) standing.add(inv.id);
        }
      }
    }
    for (const item of items) {
      if (standing.has(item.sourceId) && !bellRead(item)) news.add(item.id);
    }
  } catch (err) {
    logger.warn({ err, userId }, 'notification email: could not tell what is still unread; holding nothing back as news');
    news.clear();
  }
  return news;
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────────────

const appUrl = (path: string) => `${config.clientUrl}${path}`;
const sentOf = (result: emailService.SendEmailResult | void | undefined) => (result ? result.sent !== false : true);

/** One notification as its own email, as it was sent before the gate. */
async function sendOne(to: string, name: string, item: StoredItem): Promise<boolean> {
  switch (item.kind) {
    case 'meeting_request':
      return sentOf(await emailService.sendPokeReceivedEmail(to, name, {
        senderName: item.payload.senderName, note: item.payload.note, reasonLine: item.payload.reasonLine,
        messagesUrl: appUrl('/messages'),
      }));
    case 'meeting_accepted':
      return sentOf(await emailService.sendPokeAcceptedEmail(to, name, {
        accepterName: item.payload.accepterName, messagesUrl: appUrl(`/messages/${item.payload.conversationId}`),
      }));
    case 'direct_message':
      return sentOf(await emailService.sendDmNotificationEmail(to, name, {
        senderName: item.payload.senderName, snippet: item.payload.snippet,
        threadUrl: appUrl(`/messages/${item.payload.conversationId}`),
      }));
    case 'invite': {
      const inviteService = await import('../invite/invite.service');
      const p = item.payload;
      const context = await inviteService.buildInviteContext(p.inviterId, p.inviteType as never, {
        podId: p.podId, sessionId: p.sessionId, circleId: p.circleId,
      });
      return (await inviteService.emailInvite(context, { code: p.code, inviteeEmail: to })).sent;
    }
    default:
      return false;
  }
}

/** The email for what is going now: the notification's own email for one, a round-up for several. */
export async function sendItems(member: Pick<GateMemberRow, 'email' | 'display_name' | 'first_name'>, items: StoredItem[]): Promise<boolean> {
  if (!member.email || items.length === 0) return false;
  const name = greetingName(member);
  if (items.length === 1) return sendOne(member.email, name, items[0]);
  const { sections, counts } = sectionsOf(items, config.clientUrl);
  const result = await emailService.sendNotificationRoundupEmail(member.email, {
    recipientName: name, summary: summaryLine(counts), settingsUrl: appUrl('/settings'), ...sections,
  });
  return sentOf(result);
}

/** NOTIFICATION_EMAIL_GATE=off: the notification's own email, at once, to a member who gets such emails. */
async function sendWithoutGate(request: NotificationEmailRequest): Promise<void> {
  const member = await loadGateMember(request.userId);
  if (!member || !memberGetsNotificationEmails(gateMemberOf(member))) return;
  if (!(await switchedOn(prefsFromStored(member.notification_prefs), request.kind, new Map()))) return;
  const now = new Date();
  await sendItems(member, [{ ...request, id: request.sourceId, actorId: request.actorId ?? null, bellLink: request.bellLink ?? null, createdAt: now, sendAfter: now } as StoredItem]);
}

// ── The flush ────────────────────────────────────────────────────────────────────────────────────────────

const LET_GO_STATUS: Record<LetGoReason, 'dropped' | 'skipped'> = {
  not_eligible: 'dropped', switched_off: 'dropped', read: 'skipped', seen: 'skipped',
};

/** Rows left "sending" or "digesting" by an instance that stopped mid-send: given up on, never sent a second time. */
export async function failStuckClaims(now: Date = new Date()): Promise<number> {
  const r = await query(
    `UPDATE notification_email_outbox SET status = 'failed', reason = 'stuck'
      WHERE status IN ('sending', 'digesting') AND claimed_at < $1::timestamptz - make_interval(mins => $2)`,
    [now, STUCK_MINUTES],
  );
  await query(
    `UPDATE notification_email_deliveries SET status = 'failed'
      WHERE status = 'sending' AND created_at < $1::timestamptz - make_interval(mins => $2)`,
    [now, STUCK_MINUTES],
  );
  return r.rowCount ?? 0;
}

/** What one member's flush decided, for the log and the tests. */
export interface FlushOutcome { plan: FlushPlan | null; sent: boolean | null }

/**
 * Decide and send one member's queued rows (see the file header). Returns what was decided; null plan when another
 * instance holds the member or nothing was due.
 */
export async function flushMember(userId: string, now: Date = new Date()): Promise<FlushOutcome> {
  const rows = (await query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM notification_email_outbox
      WHERE user_id = $1 AND status = 'queued' ORDER BY created_at LIMIT ${ROWS_PER_MEMBER}`,
    [userId],
  )).rows.map(itemOf);
  if (!rows.some((i) => i.sendAfter.getTime() <= now.getTime())) return { plan: null, sent: null };

  const member = await loadGateMember(userId, now);
  const eligible = !!member && memberGetsNotificationEmails(gateMemberOf(member));
  const prefs = prefsFromStored(member?.notification_prefs ?? null);
  const typeCache = new Map<string, boolean>();
  const news = eligible ? await stillNews(userId, member!.email, rows) : new Set<string>();
  const planned: PlannedItem[] = [];
  for (const item of rows) {
    planned.push({
      id: item.id, createdAt: item.createdAt, sendAfter: item.sendAfter,
      switchedOn: eligible && (await switchedOn(prefs, item.kind, typeCache)),
      stillNews: news.has(item.id),
    });
  }
  const onlineNow = eligible && prefs.email_away_only ? (await presenceState(userId)) === 'online' : false;

  const decided = await transaction(async (client) => {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock($1, hashtext($2::text)) AS locked`, [FLUSH_LOCK_SPACE, userId]);
    if (!lock.rows[0]?.locked) return null;
    const present = new Set((await client.query<{ id: string }>(
      `SELECT id FROM notification_email_outbox WHERE id = ANY($1::uuid[]) AND status = 'queued' FOR UPDATE`,
      [rows.map((r) => r.id)],
    )).rows.map((r) => r.id));
    const localDay = member?.local_day ?? now.toISOString().slice(0, 10);
    const counted = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM notification_email_deliveries
        WHERE user_id = $1 AND kind = 'instant' AND local_day = $2::date AND status IN ('sending', 'sent')`,
      [userId, localDay],
    );
    const plan = planFlush({
      eligible, awayOnly: prefs.email_away_only, dailyMax: prefs.email_max_per_day,
      lastSeenAt: member?.last_seen_at ? new Date(member.last_seen_at) : null, onlineNow,
      sentToday: parseInt(counted.rows[0]?.n ?? '0', 10),
    }, planned.filter((p) => present.has(p.id)), now);
    if (plan.wait) return { plan, deliveryId: null as string | null };

    for (const reason of Object.keys(LET_GO_STATUS) as LetGoReason[]) {
      const ids = plan.letGo.filter((l) => l.reason === reason).map((l) => l.id);
      if (ids.length === 0) continue;
      await client.query(
        `UPDATE notification_email_outbox SET status = $2, reason = $3 WHERE id = ANY($1::uuid[])`,
        [ids, LET_GO_STATUS[reason], reason]);
    }
    if (plan.hold.length > 0) {
      await client.query(
        `UPDATE notification_email_outbox SET status = 'held', reason = 'daily_max' WHERE id = ANY($1::uuid[])`, [plan.hold]);
    }
    let deliveryId: string | null = null;
    if (plan.send.length > 0) {
      deliveryId = (await client.query<{ id: string }>(
        `INSERT INTO notification_email_deliveries (user_id, kind, local_day, status, item_count)
         VALUES ($1, 'instant', $2::date, 'sending', $3) RETURNING id`,
        [userId, localDay, plan.send.length],
      )).rows[0].id;
      await client.query(
        `UPDATE notification_email_outbox SET status = 'sending', claimed_at = $2, delivery_id = $3 WHERE id = ANY($1::uuid[])`,
        [plan.send, now, deliveryId]);
    }
    return { plan, deliveryId };
  });
  if (!decided) return { plan: null, sent: null };
  const { plan, deliveryId } = decided;
  if (plan.wait || !deliveryId || !member) return { plan, sent: null };

  const going = rows.filter((r) => plan.send.includes(r.id));
  let sent = false;
  try {
    sent = await emailService.asBulkEmail(() => sendItems(member, going));
  } catch (err) {
    logger.warn({ err, userId }, 'notification email failed to send (not retried)');
  }
  await markSent(plan.send, deliveryId, sent);
  logger.info({ userId, sent, items: plan.send.length, held: plan.hold.length, letGo: plan.letGo.length }, 'notification email flushed');
  return { plan, sent };
}

/** The rows and their delivery, once the send has answered: sent, or failed (never retried). */
export async function markSent(itemIds: string[], deliveryId: string, sent: boolean, itemStatus: 'sent' | 'digested' = 'sent'): Promise<void> {
  await query(
    `UPDATE notification_email_outbox SET status = $2, sent_at = CASE WHEN $3 THEN NOW() ELSE NULL END
      WHERE id = ANY($1::uuid[])`,
    [itemIds, sent ? itemStatus : 'failed', sent],
  );
  await query(
    `UPDATE notification_email_deliveries SET status = $2, sent_at = CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id = $1`,
    [deliveryId, sent ? 'sent' : 'failed', sent],
  );
}

/** The every-minute run: give up on stuck claims, then flush each member with a row due (oldest first). */
export async function processDueNotificationEmails(now: Date = new Date()): Promise<number> {
  if (config.notificationEmailGate === 'off') return 0;
  await failStuckClaims(now);
  const due = await query<{ user_id: string }>(
    `SELECT user_id FROM notification_email_outbox
      WHERE status = 'queued' AND send_after <= $1
      GROUP BY user_id ORDER BY MIN(send_after) LIMIT ${MEMBERS_PER_RUN}`,
    [now],
  );
  let flushed = 0;
  for (const row of due.rows) {
    try {
      const outcome = await flushMember(row.user_id, now);
      if (outcome.plan && !outcome.plan.wait) flushed += 1;
    } catch (err) {
      logger.warn({ err, userId: row.user_id }, 'notification email flush failed for a member (non-fatal)');
    }
  }
  return flushed;
}
