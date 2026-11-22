// ─── "Yesterday on REASON" and "Your week on REASON" (22 Nov 2026, Stefan) ───────────────────────────────────
//
// The daily email: what the member's "Most emails a day" held back (notification-email.service.ts), told the next
// morning from 08:00 on their own clock, only what is still unread, grouped (who wants to meet you, who accepted, the
// messages, the invites), each with its button. Admin switch: email_config 'daily_digest' (migration 160, on).
//
// The weekly email: Monday from 08:00 on the member's own clock. Their account (requests waiting for THEIR answer,
// named; their own requests still unanswered, counted, with a word of encouragement; new connections; unread
// messages), what is happening (events they may see, new members, new circles) and ideas (up to three people from
// getPlatformMatches with "Meet them", and one or two next steps). A week with nothing to say is not emailed. Admin
// switch: email_config 'weekly_digest' (migration 160, OFF until the owner has read a sample, POST
// /admin/notification-email/sample); it fails closed (a missing row is off). Member switch: Settings "Weekly digest".
//
// Neither ever goes to a guest, a closed or suspended account, a member with email switched off, or an address
// reserved for testing. Each member gets at most one of each per day: the delivery row (partial unique index on
// member, kind and their day) is the claim, so several instances running the job send it once. A send that fails is
// not retried. Both run every DIGEST_INTERVAL_MS from index.ts.

import jwt from 'jsonwebtoken';
import config from '../../config';
import logger from '../../config/logger';
import { query } from '../../db';
import { formatEventTime } from '@rsn/shared';
import * as emailService from '../email/email.service';
import { isReservedTestAddress } from '../identity/reserved-address';
import { prefsFromStored } from '../notification-prefs/notification-prefs.service';
import { visibleEventsSql } from '../session/event-access';
import {
  HELD_MAX_AGE_DAYS, type WeeklyFacts, memberGetsNotificationEmails, prefCategoryOf, sectionsOf, summaryLine,
  weeklyHasNews, weeklySuggestions,
} from './notification-email.rules';
import {
  OUTBOX_COLUMNS, type GateMemberRow, greetingName, itemOf, loadGateMember, markSent, memberZoneSql, stillNews,
} from './notification-email.service';

export const DIGEST_INTERVAL_MS = 10 * 60_000;
/** The hour, on the member's own clock, from which the morning emails go. */
export const DIGEST_HOUR = 8;
const DIGEST_MEMBERS_PER_RUN = 50;
const DAILY_EMAIL_TYPE = 'daily_digest';
const WEEKLY_EMAIL_TYPE = 'weekly_digest';
/** How long the weekly email's one-click unsubscribe link keeps working. */
const UNSUBSCRIBE_TTL = '60d';
const UNSUBSCRIBE_PURPOSE = 'weekly-digest-unsubscribe';

const appUrl = (path: string) => `${config.clientUrl}${path}`;

/** Whether this account may get a digest: a member who gets notification emails, on an address that is a real one. */
export function digestRecipient(m: GateMemberRow | null): m is GateMemberRow & { email: string } {
  return !!m && memberGetsNotificationEmails({ email: m.email, status: m.status, accountKind: m.account_kind, notifyEmail: m.notify_email })
    && !isReservedTestAddress(m.email);
}

/**
 * An admin switch that must be on to send: a row that says enabled. Unlike isEmailTypeEnabled (which fails open, so a
 * notification nobody seeded still goes), a digest goes to every member at once, so a missing row or a failed read
 * keeps it off.
 */
export async function digestSwitchOn(emailType: string): Promise<boolean> {
  try {
    const r = await query<{ enabled: boolean }>(`SELECT enabled FROM email_config WHERE email_type = $1`, [emailType]);
    return r.rows[0]?.enabled === true;
  } catch (err) {
    logger.warn({ err, emailType }, 'digest switch could not be read; treated as off');
    return false;
  }
}

/** Claim a member's daily or weekly email for their day. True for the one instance that gets it. */
async function claimDigest(userId: string, kind: 'daily' | 'weekly', localDay: string): Promise<string | null> {
  const r = await query<{ id: string }>(
    `INSERT INTO notification_email_deliveries (user_id, kind, local_day, status)
     VALUES ($1, $2, $3::date, 'sending')
     ON CONFLICT (user_id, kind, local_day) WHERE kind IN ('daily', 'weekly') DO NOTHING
     RETURNING id`,
    [userId, kind, localDay],
  );
  return r.rows[0]?.id ?? null;
}

async function settleDelivery(deliveryId: string, status: 'sent' | 'skipped' | 'failed', itemCount = 0): Promise<void> {
  // The status and whether it went are two parameters: one parameter read as both a column value and a text compared
  // with 'sent' gets two types deduced for it, and Postgres refuses the statement.
  await query(
    `UPDATE notification_email_deliveries
        SET status = $2, item_count = $3, sent_at = CASE WHEN $4 THEN NOW() ELSE NULL END
      WHERE id = $1`,
    [deliveryId, status, itemCount, status === 'sent'],
  );
}

// ── The daily email ──────────────────────────────────────────────────────────────────────────────────────

/** Held rows too old to be news are let go; finished rows and deliveries are kept a month for the record, then removed. */
export async function tidyNotificationEmails(now: Date = new Date()): Promise<void> {
  await query(
    `UPDATE notification_email_outbox SET status = 'dropped', reason = 'expired'
      WHERE status = 'held' AND created_at < $1::timestamptz - make_interval(days => $2)`,
    [now, HELD_MAX_AGE_DAYS],
  );
  await query(
    `DELETE FROM notification_email_outbox
      WHERE created_at < $1::timestamptz - INTERVAL '30 days' AND status NOT IN ('queued', 'held', 'sending', 'digesting')`,
    [now],
  );
  await query(`DELETE FROM notification_email_deliveries WHERE created_at < $1::timestamptz - INTERVAL '60 days'`, [now]);
}

/** Members with held rows from before their own today, whose own clock has passed DIGEST_HOUR, not yet emailed today. */
async function dailyCandidates(now: Date): Promise<Array<{ user_id: string; local_day: string; day_start: Date }>> {
  const zone = memberZoneSql('u');
  return (await query<{ user_id: string; local_day: string; day_start: Date }>(
    `SELECT u.id AS user_id,
            to_char(($1::timestamptz AT TIME ZONE z.zone)::date, 'YYYY-MM-DD') AS local_day,
            (date_trunc('day', $1::timestamptz AT TIME ZONE z.zone) AT TIME ZONE z.zone) AS day_start
       FROM (SELECT DISTINCT user_id FROM notification_email_outbox WHERE status = 'held') h
       JOIN users u ON u.id = h.user_id
       CROSS JOIN LATERAL (SELECT ${zone} AS zone) z
      WHERE EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE z.zone)) >= ${DIGEST_HOUR}
        AND EXISTS (SELECT 1 FROM notification_email_outbox o
                     WHERE o.user_id = u.id AND o.status = 'held'
                       AND o.created_at < (date_trunc('day', $1::timestamptz AT TIME ZONE z.zone) AT TIME ZONE z.zone))
        AND NOT EXISTS (SELECT 1 FROM notification_email_deliveries d
                         WHERE d.user_id = u.id AND d.kind = 'daily'
                           AND d.local_day = ($1::timestamptz AT TIME ZONE z.zone)::date)
      LIMIT ${DIGEST_MEMBERS_PER_RUN}`,
    [now],
  )).rows;
}

/** The daily email's content from rows, for the run and for the admin sample alike. */
export function dailyEmailData(member: GateMemberRow, items: ReturnType<typeof itemOf>[], dailyMax: number): emailService.DailyDigestEmailData {
  const { sections, counts } = sectionsOf(items, config.clientUrl);
  return { recipientName: greetingName(member), summary: summaryLine(counts), dailyMax, settingsUrl: appUrl('/settings'), ...sections };
}

/** One member's "Yesterday on REASON". Returns whether an email went. */
async function sendDailyFor(candidate: { user_id: string; local_day: string; day_start: Date }, now: Date): Promise<boolean> {
  const deliveryId = await claimDigest(candidate.user_id, 'daily', candidate.local_day);
  if (!deliveryId) return false;
  const claimed = (await query<Parameters<typeof itemOf>[0]>(
    `UPDATE notification_email_outbox SET status = 'digesting', claimed_at = $3, delivery_id = $4
      WHERE user_id = $1 AND status = 'held' AND created_at < $2
      RETURNING ${OUTBOX_COLUMNS}`,
    [candidate.user_id, candidate.day_start, now, deliveryId],
  )).rows.map(itemOf);
  const member = await loadGateMember(candidate.user_id, now);
  const letGo = async (ids: string[], status: 'dropped' | 'skipped', reason: string) => {
    if (ids.length > 0) {
      await query(`UPDATE notification_email_outbox SET status = $2, reason = $3 WHERE id = ANY($1::uuid[])`, [ids, status, reason]);
    }
  };
  if (!digestRecipient(member)) {
    await letGo(claimed.map((i) => i.id), 'dropped', 'not_eligible');
    await settleDelivery(deliveryId, 'skipped');
    return false;
  }
  const prefs = prefsFromStored(member.notification_prefs);
  const news = await stillNews(member.id, member.email, claimed);
  const going = claimed.filter((i) => news.has(i.id) && prefs[`${prefCategoryOf(i.kind)}_email`]);
  await letGo(claimed.filter((i) => !going.includes(i)).map((i) => i.id), 'skipped', 'read');
  if (going.length === 0) {
    await settleDelivery(deliveryId, 'skipped');
    return false;
  }
  let sent = false;
  try {
    const result = await emailService.sendDailyDigestEmail(member.email, dailyEmailData(member, going, prefs.email_max_per_day));
    sent = result.sent;
  } catch (err) {
    logger.warn({ err, userId: member.id }, 'daily digest failed to send (not retried)');
  }
  await markSent(going.map((i) => i.id), deliveryId, sent, 'digested');
  await settleDelivery(deliveryId, sent ? 'sent' : 'failed', going.length);
  return sent;
}

export async function processDailyDigests(now: Date = new Date()): Promise<number> {
  if (config.notificationEmailGate === 'off') return 0;
  await tidyNotificationEmails(now);
  if (!(await emailService.isEmailTypeEnabled(DAILY_EMAIL_TYPE))) return 0;
  let sent = 0;
  await emailService.asBulkEmail(async () => {
    for (const candidate of await dailyCandidates(now)) {
      try {
        if (await sendDailyFor(candidate, now)) sent += 1;
      } catch (err) {
        logger.warn({ err, userId: candidate.user_id }, 'daily digest failed for a member (non-fatal)');
      }
    }
  });
  return sent;
}

// ── The weekly email ─────────────────────────────────────────────────────────────────────────────────────

const nameSql = (alias: string) => `COALESCE(NULLIF(trim(${alias}.display_name), ''), NULLIF(trim(${alias}.first_name), ''), 'A member')`;
const notBlockedSql = (a: string, b: string) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id = ${a} AND ub.blocked_id = ${b}) OR (ub.blocker_id = ${b} AND ub.blocked_id = ${a}))`;

/** Everything the weekly email could say about this member's week, read now. */
export async function weeklyFacts(userId: string, now: Date = new Date()): Promise<WeeklyFacts> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [waiting, sentOpen, connections, unread, oldestUnread, events, members, circles] = await Promise.all([
    query<{ user_id: string; name: string }>(
      `SELECT p.sender_id AS user_id, ${nameSql('u')} AS name
         FROM user_pokes p JOIN users u ON u.id = p.sender_id
        WHERE p.recipient_id = $1 AND p.status = 'pending' AND u.status = 'active' AND ${notBlockedSql('p.sender_id', '$1')}
        ORDER BY p.created_at LIMIT 50`, [userId]),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_pokes p JOIN users u ON u.id = p.recipient_id
        WHERE p.sender_id = $1 AND p.status = 'pending' AND u.status = 'active'`, [userId]),
    query<{ user_id: string; name: string; conversation_id: string | null }>(
      `SELECT o.id AS user_id, ${nameSql('o')} AS name,
              (SELECT c.id FROM dm_conversations c
                WHERE (c.user_a_id = $1 AND c.user_b_id = o.id) OR (c.user_b_id = $1 AND c.user_a_id = o.id) LIMIT 1) AS conversation_id
         FROM user_pokes p
         JOIN users o ON o.id = CASE WHEN p.sender_id = $1 THEN p.recipient_id ELSE p.sender_id END
        WHERE (p.sender_id = $1 OR p.recipient_id = $1) AND p.status = 'accepted' AND p.responded_at >= $2
          AND o.status = 'active'
        ORDER BY p.responded_at DESC LIMIT 5`, [userId, weekAgo]),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM direct_messages dm JOIN dm_conversations c ON c.id = dm.conversation_id
        WHERE dm.from_user_id <> $1 AND dm.read_at IS NULL
          AND ((c.user_a_id = $1 AND c.user_a_deleted_at IS NULL) OR (c.user_b_id = $1 AND c.user_b_deleted_at IS NULL))`, [userId]),
    query<{ name: string; conversation_id: string }>(
      `SELECT ${nameSql('u')} AS name, dm.conversation_id
         FROM direct_messages dm JOIN dm_conversations c ON c.id = dm.conversation_id JOIN users u ON u.id = dm.from_user_id
        WHERE dm.from_user_id <> $1 AND dm.read_at IS NULL AND COALESCE(dm.kind, 'user') = 'user' AND u.status = 'active'
          AND ((c.user_a_id = $1 AND c.user_a_deleted_at IS NULL) OR (c.user_b_id = $1 AND c.user_b_deleted_at IS NULL))
        ORDER BY dm.created_at LIMIT 1`, [userId]),
    query<{ id: string; title: string; scheduled_at: Date; timezone: string | null; going: boolean }>(
      `SELECT s.id, s.title, s.scheduled_at, s.timezone,
              EXISTS (SELECT 1 FROM session_participants sp
                       WHERE sp.session_id = s.id AND sp.user_id = $1 AND sp.status NOT IN ('removed', 'left')) AS going
         FROM sessions s
        WHERE s.status = 'scheduled' AND s.scheduled_at > $2 AND s.scheduled_at < $2::timestamptz + INTERVAL '14 days'
          AND ${visibleEventsSql('s', '$1')}
        ORDER BY s.scheduled_at LIMIT 3`, [userId, now]),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users
        WHERE status = 'active' AND account_kind = 'member' AND created_at >= $2 AND id <> $1`, [userId, weekAgo]),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM circles WHERE archived_at IS NULL AND created_at >= $1 ORDER BY created_at DESC LIMIT 3`, [weekAgo]),
  ]);

  let people: WeeklyFacts['people'] = [];
  let profileIncomplete = false;
  try {
    const { getPlatformMatches } = await import('../matching/platform-match.service');
    const matches = await getPlatformMatches(userId, { limit: 3 });
    profileIncomplete = matches.profileIncomplete;
    people = matches.matches
      .filter((m) => !m.pokeStatus)
      .slice(0, 3)
      .map((m) => ({ userId: m.userId, name: m.displayName?.trim() || 'A member', line: m.theyCanBring || m.professionalRole || null }));
  } catch (err) {
    logger.warn({ err, userId }, 'weekly digest: suggestions could not be read; sent without them');
  }

  return {
    waitingForYou: waiting.rows.map((r) => ({ userId: r.user_id, name: r.name })),
    sentUnanswered: parseInt(sentOpen.rows[0]?.n ?? '0', 10),
    newConnections: connections.rows.map((r) => ({ userId: r.user_id, name: r.name, conversationId: r.conversation_id })),
    unreadMessages: parseInt(unread.rows[0]?.n ?? '0', 10),
    oldestUnreadFrom: oldestUnread.rows[0] ? { name: oldestUnread.rows[0].name, conversationId: oldestUnread.rows[0].conversation_id } : null,
    upcomingEvents: events.rows.map((e) => ({
      id: e.id, title: e.title, when: formatEventTime(e.scheduled_at, e.timezone, 'long'), going: e.going,
    })),
    newMembers: parseInt(members.rows[0]?.n ?? '0', 10),
    newCircles: circles.rows.map((c) => ({ id: c.id, name: c.name })),
    people,
    profileIncomplete,
  };
}

/** The weekly email's content from the facts. Requests waiting for an answer: three named, the rest counted. */
export function weeklyEmailData(name: string, f: WeeklyFacts, unsubscribeUrl: string): emailService.WeeklyDigestEmailData {
  const shown = f.waitingForYou.slice(0, 3);
  return {
    recipientName: name,
    waitingForYou: shown.map((w) => ({ name: w.name, url: appUrl(`/people/${w.userId}`) })),
    waitingForYouMore: f.waitingForYou.length - shown.length,
    sentUnanswered: f.sentUnanswered,
    newConnections: f.newConnections.map((c) => ({
      name: c.name, url: appUrl(c.conversationId ? `/messages/${c.conversationId}` : `/people/${c.userId}`),
    })),
    unreadMessages: f.unreadMessages,
    messagesUrl: appUrl('/messages'),
    upcomingEvents: f.upcomingEvents.map((e) => ({ title: e.title, when: e.when, url: appUrl(`/sessions/${e.id}`) })),
    newMembers: f.newMembers,
    newCircles: f.newCircles.map((c) => ({ name: c.name, url: appUrl(`/circles/${c.id}`) })),
    people: f.people.map((p) => ({ name: p.name, line: p.line, url: appUrl(`/people/${p.userId}`) })),
    suggestions: weeklySuggestions(f, config.clientUrl),
    settingsUrl: appUrl('/settings'),
    unsubscribeUrl,
  };
}

/** The weekly email's one-click unsubscribe token: signed, for this member only, and for nothing else. */
export function mintUnsubscribeToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: UNSUBSCRIBE_PURPOSE }, config.jwtSecret, { expiresIn: UNSUBSCRIBE_TTL });
}

/** The member a weekly unsubscribe token is for, or null for anything else (forged, expired, another kind). */
export function readUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2000) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: unknown; purpose?: unknown };
    return payload.purpose === UNSUBSCRIBE_PURPOSE && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrlFor(userId: string): string {
  return `${config.apiBaseUrl}/api/email/unsubscribe/weekly?token=${encodeURIComponent(mintUnsubscribeToken(userId))}`;
}

/** Members whose own clock says Monday, DIGEST_HOUR or later, with the weekly email on, not yet sent it today. */
async function weeklyCandidates(now: Date): Promise<Array<{ user_id: string; local_day: string; email: string }>> {
  const zone = memberZoneSql('u');
  return (await query<{ user_id: string; local_day: string; email: string }>(
    `SELECT u.id AS user_id, u.email,
            to_char(($1::timestamptz AT TIME ZONE z.zone)::date, 'YYYY-MM-DD') AS local_day
       FROM users u
       CROSS JOIN LATERAL (SELECT ${zone} AS zone) z
      WHERE u.status = 'active' AND u.account_kind = 'member' AND u.notify_email = TRUE AND u.email IS NOT NULL
        AND (u.notification_prefs->>'weekly_digest') IS DISTINCT FROM 'false'
        AND EXTRACT(ISODOW FROM ($1::timestamptz AT TIME ZONE z.zone)) = 1
        AND EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE z.zone)) >= ${DIGEST_HOUR}
        AND NOT EXISTS (SELECT 1 FROM notification_email_deliveries d
                         WHERE d.user_id = u.id AND d.kind = 'weekly'
                           AND d.local_day = ($1::timestamptz AT TIME ZONE z.zone)::date)
      ORDER BY u.id
      LIMIT ${DIGEST_MEMBERS_PER_RUN}`,
    [now],
  )).rows;
}

async function sendWeeklyFor(candidate: { user_id: string; local_day: string }, now: Date): Promise<boolean> {
  const deliveryId = await claimDigest(candidate.user_id, 'weekly', candidate.local_day);
  if (!deliveryId) return false;
  const member = await loadGateMember(candidate.user_id, now);
  if (!digestRecipient(member) || !prefsFromStored(member.notification_prefs).weekly_digest) {
    await settleDelivery(deliveryId, 'skipped');
    return false;
  }
  const facts = await weeklyFacts(member.id, now);
  if (!weeklyHasNews(facts)) {
    await settleDelivery(deliveryId, 'skipped');
    return false;
  }
  let sent = false;
  try {
    sent = (await emailService.sendWeeklyDigestEmail(member.email,
      weeklyEmailData(greetingName(member), facts, unsubscribeUrlFor(member.id)))).sent;
  } catch (err) {
    logger.warn({ err, userId: member.id }, 'weekly digest failed to send (not retried)');
  }
  await settleDelivery(deliveryId, sent ? 'sent' : 'failed');
  return sent;
}

export async function processWeeklyDigests(now: Date = new Date()): Promise<number> {
  if (config.notificationEmailGate === 'off') return 0;
  if (!(await digestSwitchOn(WEEKLY_EMAIL_TYPE))) return 0;
  let sent = 0;
  await emailService.asBulkEmail(async () => {
    for (const candidate of await weeklyCandidates(now)) {
      try {
        // A reserved test address is claimed and skipped, so the run never picks it again this week.
        if (isReservedTestAddress(candidate.email)) {
          const id = await claimDigest(candidate.user_id, 'weekly', candidate.local_day);
          if (id) await settleDelivery(id, 'skipped');
          continue;
        }
        if (await sendWeeklyFor(candidate, now)) sent += 1;
      } catch (err) {
        logger.warn({ err, userId: candidate.user_id }, 'weekly digest failed for a member (non-fatal)');
      }
    }
  });
  return sent;
}

// ── The admin's sample ───────────────────────────────────────────────────────────────────────────────────

/** An example "Yesterday on REASON" for an admin who has nothing held of their own: invented names, marked as such. */
function exampleDaily(member: GateMemberRow, dailyMax: number): emailService.DailyDigestEmailData {
  const url = appUrl('/messages');
  return {
    recipientName: greetingName(member),
    summary: summaryLine({ meetingRequests: 2, acceptances: 1, messages: 3, invites: 1 }),
    dailyMax,
    settingsUrl: appUrl('/settings'),
    meetingRequests: [
      { name: 'Anna Example', note: 'Sample: I saw you work on climate tech. Coffee next week?', url },
      { name: 'Ben Example', note: null, url },
    ],
    acceptances: [{ name: 'Clara Example', url }],
    messages: [{ name: 'David Example', count: 3, snippet: 'Sample: great to meet you yesterday!', url }],
    invites: [{ inviterName: 'Eva Example', targetName: 'Sample Founders Breakfast', what: 'event', url: appUrl('/sessions') }],
  };
}

export interface SampleResult { sent: boolean; to: string; example: boolean }

/**
 * One sample of the daily or weekly email to the admin's own address, built from their own account (the daily from
 * their last week of notification emails, or an example when there is none), whatever the switches say: the owner
 * reads the real email before switching it on for everyone.
 */
export async function sendDigestSample(adminId: string, kind: 'weekly' | 'daily', now: Date = new Date()): Promise<SampleResult> {
  const member = await loadGateMember(adminId, now);
  if (!member?.email) return { sent: false, to: '', example: false };
  const prefs = prefsFromStored(member.notification_prefs);
  if (kind === 'weekly') {
    const facts = await weeklyFacts(member.id, now);
    const result = await emailService.sendWeeklyDigestEmail(member.email, weeklyEmailData(greetingName(member), facts, unsubscribeUrlFor(member.id)));
    return { sent: result.sent, to: member.email, example: !weeklyHasNews(facts) };
  }
  const recent = (await query<Parameters<typeof itemOf>[0]>(
    `SELECT ${OUTBOX_COLUMNS} FROM notification_email_outbox
      WHERE user_id = $1 AND created_at >= $2::timestamptz - INTERVAL '7 days'
      ORDER BY created_at DESC LIMIT 12`,
    [member.id, now],
  )).rows.map(itemOf);
  const data = recent.length > 0 ? dailyEmailData(member, recent, prefs.email_max_per_day) : exampleDaily(member, prefs.email_max_per_day);
  const result = await emailService.sendDailyDigestEmail(member.email, data);
  return { sent: result.sent, to: member.email, example: recent.length === 0 };
}
