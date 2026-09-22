// ─── Meeting Windows Service ─────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026) — Stefan's "setup availability to be
// introduced". After a mutual yes opens a conversation, each side picks time
// windows (day + daypart), the overlap is visible to both, and either side
// confirms one overlapping window. Confirming drops a message into the thread
// (so it lives in the chat history) and bell-notifies the partner.
//
// Deliberately time-windows-only — no calendar OAuth (Ali's locked decision).
// window_key: 'YYYY-MM-DD:morning|afternoon|evening', validated to a rolling
// horizon so nobody can select the past or a date a year out.

import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as dmService from './dm.service';

export const DAYPARTS = ['morning', 'afternoon', 'evening'] as const;
export type Daypart = typeof DAYPARTS[number];
export const HORIZON_DAYS = 30; // selections allowed today..today+30

const WINDOW_RE = /^(\d{4})-(\d{2})-(\d{2}):(morning|afternoon|evening)$/;
// 9 Sep 2026 (Stefan): concrete 30-minute slots stored as UTC instants, so two
// timezones overlap on the same instant and each side renders its own local
// time. 'YYYY-MM-DDTHH:MM:00Z' — minutes must be :00 or :30.
const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00Z$/;
export const SLOT_MINUTES = 30;
/** Is this key a concrete time slot (vs a legacy day-part window)? */
export function isSlotKey(key: string): boolean {
  return SLOT_RE.test(key);
}

export interface ConversationScheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: {
    window: string;
    byUserId: string;
    at: Date;
    /** Absolute meeting instant + duration (W6). Null for legacy daypart-only
     *  confirmations; the client falls back to the daypart label then. */
    startAt: Date | null;
    durationMin: number | null;
    /** 'audio' | 'video' — the kind of call this meeting is (W-meet). */
    type: 'audio' | 'video' | null;
  } | null;
  /** W-meet (8 Sep 2026): the partner changed their availability more recently
   *  than I last opened the scheduler — drives the calendar-icon dot. */
  schedulingUpdated: boolean;
  /** 9 Sep 2026 (Ali): calls unlock once this pair's first scheduled meeting has
   *  happened (both joined). Until then the chat shows the scheduler, not calls;
   *  after, the scheduler steps aside and calls appear. */
  callsUnlocked: boolean;
}

// ── Validation (pure — unit-tested directly) ─────────────────────────────────

/**
 * A window key is valid when it parses, is a REAL calendar date, and falls
 * inside [today, today+HORIZON_DAYS] in UTC. `now` injectable for tests.
 */
export function isValidWindowKey(key: string, now = new Date()): boolean {
  // Concrete slot: a real instant, on a 30-minute boundary, from the current
  // slot (30 min of grace) up to the horizon.
  const s = SLOT_RE.exec(key);
  if (s) {
    const t = new Date(key);
    if (isNaN(t.getTime()) || t.toISOString().replace('.000Z', 'Z') !== key) return false;
    if (t.getUTCMinutes() % SLOT_MINUTES !== 0) return false;
    const delta = t.getTime() - now.getTime();
    return delta >= -SLOT_MINUTES * 60_000 && delta <= HORIZON_DAYS * 86_400_000;
  }
  const m = WINDOW_RE.exec(key);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Reject impossible dates like 2026-02-31 (Date silently rolls them over).
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    return false;
  }
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = (date.getTime() - todayUtc) / 86_400_000;
  return diffDays >= 0 && diffDays <= HORIZON_DAYS;
}

/** Human label for the confirmation message: "Tue 22 Jul, evening". */
export function windowLabel(key: string, timeZone?: string | null): string {
  // A concrete slot is one instant; render it in the reader's timezone when we
  // know it (notifications), else UTC. The shared thread line embeds the
  // instant itself and each client localises it.
  const s = SLOT_RE.exec(key);
  if (s) {
    const date = new Date(key);
    const fmt = (tz: string) => new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).formatToParts(date);
    let parts: Intl.DateTimeFormatPart[];
    try { parts = fmt(timeZone || 'UTC'); } catch { parts = fmt('UTC'); }
    const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
    // en-GB for real zone names (CEST, not GMT+2) but its "Sept" → our own month list.
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p('month')) - 1];
    return `${p('weekday')} ${p('day')} ${month}, ${p('hour')}:${p('minute')} ${p('timeZoneName')}`;
  }
  const m = WINDOW_RE.exec(key);
  if (!m) return key;
  const [, y, mo, d, part] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  return `${dayName} ${date.getUTCDate()} ${monthName}, ${part}`;
}

// ── Access ───────────────────────────────────────────────────────────────────

interface ConversationRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  meeting_confirmed_window: string | null;
  meeting_confirmed_by: string | null;
  meeting_confirmed_at: Date | null;
  meeting_start_at: Date | null;
  meeting_duration_min: number | null;
  meeting_type: 'audio' | 'video' | null;
  avail_updated_at_a: Date | null;
  avail_updated_at_b: Date | null;
  scheduler_seen_at_a: Date | null;
  scheduler_seen_at_b: Date | null;
  calls_unlocked_at: Date | null;
}

/** Load the conversation and prove the caller belongs to it. */
async function requireParticipant(conversationId: string, userId: string): Promise<ConversationRow> {
  const r = await query<ConversationRow>(
    `SELECT id, user_a_id, user_b_id,
            meeting_confirmed_window, meeting_confirmed_by, meeting_confirmed_at,
            meeting_start_at, meeting_duration_min, meeting_type,
            avail_updated_at_a, avail_updated_at_b,
            scheduler_seen_at_a, scheduler_seen_at_b,
            calls_unlocked_at
     FROM dm_conversations WHERE id = $1`,
    [conversationId],
  );
  const conv = r.rows[0];
  if (!conv) throw new NotFoundError('Conversation', conversationId);
  if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Not your conversation');
  }
  return conv;
}

function buildScheduling(
  conv: ConversationRow,
  userId: string,
  rows: Array<{ user_id: string; window_key: string }>,
): ConversationScheduling {
  const mine = rows.filter(r => r.user_id === userId).map(r => r.window_key).sort();
  const theirs = rows.filter(r => r.user_id !== userId).map(r => r.window_key).sort();
  const theirSet = new Set(theirs);

  // Dot logic: the partner changed availability more recently than I last
  // opened the scheduler. Which timestamp is "mine" vs "theirs" depends on
  // whether I'm side A or B of the conversation.
  const iAmA = conv.user_a_id === userId;
  const partnerAvailUpdated = iAmA ? conv.avail_updated_at_b : conv.avail_updated_at_a;
  const mySchedulerSeen = iAmA ? conv.scheduler_seen_at_a : conv.scheduler_seen_at_b;
  const schedulingUpdated = !!partnerAvailUpdated
    && (!mySchedulerSeen || partnerAvailUpdated.getTime() > mySchedulerSeen.getTime());

  return {
    conversationId: conv.id,
    partnerId: conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id,
    mine,
    theirs,
    overlap: mine.filter(w => theirSet.has(w)),
    confirmed: conv.meeting_confirmed_window
      ? {
          window: conv.meeting_confirmed_window,
          byUserId: conv.meeting_confirmed_by!,
          at: conv.meeting_confirmed_at!,
          startAt: conv.meeting_start_at,
          durationMin: conv.meeting_duration_min,
          type: conv.meeting_type,
        }
      : null,
    schedulingUpdated,
    callsUnlocked: !!conv.calls_unlocked_at,
  };
}

// ── System messages in the thread ────────────────────────────────────────────

/** One proposal card per conversation per 10 minutes, however often they save. */
const PROPOSAL_COOLDOWN_MS = 10 * 60 * 1000;

/** A meeting stops standing 30 minutes after it should have ended. */
export function isMeetingOver(startAt: Date | null, durationMin: number | null, now = new Date()): boolean {
  if (!startAt) return false;
  return now.getTime() > startAt.getTime() + (durationMin ?? 30) * 60_000 + 30 * 60_000;
}

/** One stable calendar identity per meeting, shared by every copy of the file. */
export function meetingUid(conversationId: string, startAt: Date): string {
  return `meeting-${conversationId}-${startAt.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z')}`;
}

/** Has this time already gone? A daypart key counts as past after its day. */
export function isPastKey(key: string, now = new Date()): boolean {
  if (isSlotKey(key)) return new Date(key).getTime() < now.getTime();
  const m = WINDOW_RE.exec(key);
  if (!m) return false;
  const [, y, mo, d] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d)) + 86_400_000 < now.getTime();
}

/** Times BOTH sides still have, sorted, past ones dropped. */
function futureOverlap(rows: Array<{ user_id: string; window_key: string }>, userId: string): string[] {
  const mine = new Set(rows.filter(r => r.user_id === userId).map(r => r.window_key));
  return rows
    .filter(r => r.user_id !== userId && mine.has(r.window_key) && !isPastKey(r.window_key))
    .map(r => r.window_key)
    .sort();
}

/** Someone who blocked you should never receive a meeting card from you. */
async function assertNotBlocked(conv: ConversationRow, userId: string): Promise<void> {
  const partnerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
  const blockService = await import('../block/block.service');
  if (await blockService.areBlocked(userId, partnerId)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'You can no longer arrange a meeting with this person');
  }
}

/**
 * Put a freshly written system card on both screens, and optionally ring the
 * partner. Every step is separately best-effort: the row is already committed,
 * and a socket or bell hiccup must never look like the action failed.
 */
async function announce(
  conversationId: string,
  userId: string,
  partnerId: string,
  posted: { sent: { message: unknown; conversationId: string } } | null,
  bell: { type: string; title: string; body: string } | null,
): Promise<void> {
  if (posted) {
    try {
      const { io } = await import('../../index');
      const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
      await broadcastDmMessage(io, userId, partnerId, posted.sent.conversationId, posted.sent.message as never, { notify: false });
    } catch (err) {
      logger.warn({ err, conversationId }, 'system card broadcast failed (card itself is stored)');
    }
  }
  if (bell) {
    try {
      const inserted = await query<{ id: string; created_at: Date }>(
        `INSERT INTO notifications (id, user_id, type, title, body, link)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id, created_at`,
        [partnerId, bell.type, bell.title, bell.body, `/messages/${conversationId}`],
      );
      const { io } = await import('../../index');
      io.to(`user:${partnerId}`).emit('notification:new', {
        id: inserted.rows[0].id, type: bell.type, title: bell.title, body: bell.body,
        link: `/messages/${conversationId}`, isRead: false, createdAt: inserted.rows[0].created_at,
      });
    } catch (err) {
      logger.warn({ err, conversationId }, 'meeting bell failed (non-fatal)');
    }
  }
  // BOTH sides: my own other tabs need this as much as the partner does.
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await emitEntities(io, [userId, partnerId], [
      E.dmConversation(conversationId), E.userDms(userId), E.userDms(partnerId),
    ]);
    if (bell) await emitEntities(io, [partnerId], [E.userNotifications(partnerId)]);
  } catch (err) {
    logger.warn({ err, conversationId }, 'scheduling entity emit failed (non-fatal)');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getScheduling(conversationId: string, userId: string): Promise<ConversationScheduling> {
  const conv = await requireParticipant(conversationId, userId);
  const rows = await query<{ user_id: string; window_key: string }>(
    `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
    [conversationId],
  );
  return buildScheduling(conv, userId, rows.rows);
}

/**
 * Replace MY selected windows for this conversation (idempotent set-style
 * semantics: what you send is what you have). Max 21 windows (7 days × 3).
 */
export async function setAvailability(
  conversationId: string,
  userId: string,
  windows: string[],
): Promise<ConversationScheduling> {
  const conv = await requireParticipant(conversationId, userId);
  await assertNotBlocked(conv, userId);
  const unique = [...new Set(windows)];
  // 30-min slots over a week are many more than 7×3 day-parts.
  if (unique.length > 200) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Too many times selected (max 200)');
  }
  // Times that have already passed are DROPPED, not rejected. The client
  // re-sends every saved time on each save and cannot untick a past one, so
  // rejecting the payload meant that once your earliest saved time went by,
  // saving failed for good — "Could not save availability" with no way out.
  // Come back the next day and the whole panel was dead (19 Sep, latent).
  const kept: string[] = [];
  for (const w of unique) {
    if (isPastKey(w)) continue;
    if (!isValidWindowKey(w)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Invalid or out-of-range window: ${w}`);
    }
    kept.push(w);
  }

  const iAmA = conv.user_a_id === userId;
  const partnerId = iAmA ? conv.user_b_id : conv.user_a_id;
  const stampCol = iAmA ? 'avail_updated_at_a' : 'avail_updated_at_b';
  const sharedCol = iAmA ? 'avail_shared_at_a' : 'avail_shared_at_b';

  // One transaction, conversation row locked: two people pressing Save at the
  // same moment must not both decide they were the one who created the overlap
  // and post two proposal cards.
  const posted = await transaction(async (client) => {
    const locked = await client.query<{
      avail_shared_at_a: Date | null; avail_shared_at_b: Date | null;
      meeting_proposed_key: string | null; meeting_proposed_at: Date | null;
      meeting_confirmed_window: string | null;
    }>(
      `SELECT avail_shared_at_a, avail_shared_at_b, meeting_proposed_key, meeting_proposed_at,
              meeting_confirmed_window
       FROM dm_conversations WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    const row = locked.rows[0];

    const before = await client.query<{ user_id: string; window_key: string }>(
      `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
      [conversationId],
    );
    const hadOverlap = futureOverlap(before.rows, userId).length > 0;
    const iHadSlots = before.rows.some(r => r.user_id === userId && !isPastKey(r.window_key));

    // Prune everyone's expired rows while we are here, so the table does not
    // grow a tail of times nobody can pick any more.
    await client.query(
      `DELETE FROM meeting_availability WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (kept.length) {
      await client.query(
        `INSERT INTO meeting_availability (conversation_id, user_id, window_key)
         SELECT $1, $2, k FROM unnest($3::text[]) AS k
         ON CONFLICT DO NOTHING`,
        [conversationId, userId, kept],
      );
    }
    // Stamp WHEN I changed my availability so the partner's dot can tell it's
    // newer than the last time they looked.
    await client.query(
      `UPDATE dm_conversations SET ${stampCol} = NOW() WHERE id = $1`,
      [conversationId],
    );

    const after = await client.query<{ user_id: string; window_key: string }>(
      `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
      [conversationId],
    );
    const overlapNow = futureOverlap(after.rows, userId);

    // Nothing is said once a meeting is already set: the thread would be
    // telling people to pick a time they have already agreed.
    if (row?.meeting_confirmed_window) return null;

    // The overlap just came into existence — that is the moment worth a card,
    // and it is usually the SECOND person's own Save that creates it.
    if (overlapNow.length > 0 && !hadOverlap) {
      const key = overlapNow[0];
      const cooled = !row?.meeting_proposed_at
        || Date.now() - new Date(row.meeting_proposed_at).getTime() > PROPOSAL_COOLDOWN_MS;
      if (row?.meeting_proposed_key !== key && cooled) {
        await client.query(
          `UPDATE dm_conversations SET meeting_proposed_key = $2, meeting_proposed_at = NOW() WHERE id = $1`,
          [conversationId, key],
        );
        const shown = overlapNow.slice(0, 3);
        const content = `You are both free: ${shown.map(k => windowLabel(k)).join(', ')}. Pick one to confirm.`;
        const sent = await dmService.insertDirectMessageOn(
          client, userId, partnerId, content, null,
          { kind: 'system', systemMeta: { type: 'meeting_proposal', slots: shown } },
        );
        return { type: 'meeting_proposal' as const, sent };
      }
      return null;
    }

    // First time this side has shared anything: tell the other person there is
    // something to match against, once per side, ever.
    const alreadyShared = iAmA ? row?.avail_shared_at_a : row?.avail_shared_at_b;
    if (kept.length > 0 && !iHadSlots && !alreadyShared && overlapNow.length === 0) {
      await client.query(
        `UPDATE dm_conversations SET ${sharedCol} = NOW() WHERE id = $1`,
        [conversationId],
      );
      const me = await client.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`, [userId],
      );
      const name = me.rows[0]?.display_name || 'They';
      const content = `${name} shared times they can meet. Add yours to find a match.`;
      const sent = await dmService.insertDirectMessageOn(
        client, userId, partnerId, content, null,
        { kind: 'system', systemMeta: { type: 'availability_shared' } },
      );
      return { type: 'availability_shared' as const, sent };
    }
    return null;
  });

  await announce(conversationId, userId, partnerId, posted, posted?.type === 'meeting_proposal'
    ? { type: 'meeting_proposed', title: 'You can both meet', body: 'Pick a time to confirm your meeting.' }
    : null);

  const conv2 = await requireParticipant(conversationId, userId);
  const rows = await query<{ user_id: string; window_key: string }>(
    `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
    [conversationId],
  );
  return buildScheduling(conv2, userId, rows.rows);
}

/**
 * Mark that I've just looked at the scheduler — clears my calendar-icon dot.
 * Idempotent; safe to call every time the panel opens.
 */
export async function markSchedulerSeen(conversationId: string, userId: string): Promise<void> {
  const conv = await requireParticipant(conversationId, userId);
  const col = conv.user_a_id === userId ? 'scheduler_seen_at_a' : 'scheduler_seen_at_b';
  await query(`UPDATE dm_conversations SET ${col} = NOW() WHERE id = $1`, [conversationId]);
}

/**
 * Confirm one OVERLAPPING window. Writes the confirmation onto the
 * conversation, drops a message into the thread (visible history, and
 * dm.service.sendMessage handles the partner's realtime + notification rails),
 * and bell-notifies the partner explicitly as 'meeting_confirmed'.
 */
export async function confirmWindow(
  conversationId: string,
  userId: string,
  windowKey: string,
  opts: { startAt?: string | null; durationMin?: number | null; type?: 'audio' | 'video' | null } = {},
): Promise<ConversationScheduling> {
  const conv = await requireParticipant(conversationId, userId);
  await assertNotBlocked(conv, userId);
  if (!isValidWindowKey(windowKey)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid or out-of-range window');
  }

  const rows = await query<{ user_id: string; window_key: string }>(
    `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
    [conversationId],
  );
  const mine = rows.rows.some(r => r.user_id === userId && r.window_key === windowKey);
  const theirs = rows.rows.some(r => r.user_id !== userId && r.window_key === windowKey);
  if (!mine || !theirs) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You can only confirm a time you BOTH selected');
  }

  // W6: an optional exact start + duration turns the daypart into a real meeting
  // — an absolute instant every client renders in its own local time, plus a
  // calendar invite. Validate the instant is real, future, and on/near the
  // confirmed day; fall back to daypart-only if absent (legacy behaviour).
  // A concrete slot IS the start time — no separate time input (9 Sep 2026).
  if (isSlotKey(windowKey) && !opts.startAt) opts = { ...opts, startAt: windowKey };

  let startAt: Date | null = null;
  let durationMin: number | null = null;
  if (opts.startAt) {
    const parsed = new Date(opts.startAt);
    if (isNaN(parsed.getTime())) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid meeting start time');
    }
    if (parsed.getTime() < Date.now() - 60_000) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Meeting time must be in the future');
    }
    const dayFromKey = windowKey.slice(0, 10); // YYYY-MM-DD (both key formats)
    if (parsed.toISOString().slice(0, 10) !== dayFromKey) {
      // Timezone can shift the UTC calendar day by one; allow ±1 day only.
      const keyMs = new Date(`${dayFromKey}T12:00:00Z`).getTime();
      if (Math.abs(parsed.getTime() - keyMs) > 36 * 60 * 60 * 1000) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Meeting time is not on the confirmed day');
      }
    }
    startAt = parsed;
    // Custom length (Ali, 9 Sep): any number of minutes the member types, 5–240.
    durationMin = Math.min(240, Math.max(5, Math.round(opts.durationMin ?? 30)));
  }
  const meetingType: 'audio' | 'video' | null = startAt
    ? (opts.type === 'audio' ? 'audio' : 'video')
    : null;

  const partnerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
  const people = await query<{ id: string; display_name: string | null; email: string | null; timezone: string | null }>(
    `SELECT id, display_name, email, timezone FROM users WHERE id = ANY($1)`,
    [[userId, partnerId]],
  );
  const byId = new Map(people.rows.map(p => [p.id, p]));
  const lengthNote = startAt && durationMin ? ` · ${durationMin} min ${meetingType} call` : '';
  // Bell text is per-reader, so use the partner's own timezone when we know it.
  const label = windowLabel(windowKey, byId.get(partnerId)?.timezone) + lengthNote;
  // The thread line is one shared text: for a slot it carries the instant
  // itself and each client renders it in its own local time. The wording is
  // kept as it was, because cached clients and the inbox preview match on it.
  const threadLine = isSlotKey(windowKey)
    ? `📅 Meeting confirmed: ${windowKey}${lengthNote}`
    : `📅 Meeting confirmed: ${windowLabel(windowKey)}`;
  const joinPath = `/meet/${conversationId}?scheduled=1&kind=${meetingType ?? 'video'}`;

  // One transaction: the meeting and the card that tells both people about it
  // land together or not at all. The row is locked first, so a double press —
  // or both people confirming at the same moment — cannot produce two meetings,
  // two cards, two bells and four emails.
  const outcome = await transaction(async (client) => {
    const locked = await client.query<{
      meeting_confirmed_window: string | null; meeting_start_at: Date | null; meeting_duration_min: number | null;
    }>(
      `SELECT meeting_confirmed_window, meeting_start_at, meeting_duration_min
       FROM dm_conversations WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    const cur = locked.rows[0];
    let movedFrom: string | null = null;
    if (cur?.meeting_confirmed_window) {
      const over = isMeetingOver(cur.meeting_start_at, cur.meeting_duration_min);
      // Pressing Confirm twice, or the partner's press landing first: this is
      // the same meeting, so say yes and do nothing again.
      if (cur.meeting_confirmed_window === windowKey && !over) return { already: true as const };
      // A DIFFERENT time while one still stands is a MOVE. Refusing it looked
      // safer, but there is no way to cancel a meeting, so refusing left a pair
      // who needed Thursday instead of Tuesday with no way out at all. The row
      // lock already settles two simultaneous presses; what was missing was
      // telling the person counting on the old time that it changed, which the
      // card and the bell now do.
      // Only an exact instant: the card renders this in the reader's own time,
      // and a day-part key ("2026-09-24:evening") would land on screen raw.
      if (!over && cur.meeting_start_at) movedFrom = cur.meeting_start_at.toISOString();
    }

    await client.query(
      `UPDATE dm_conversations
       SET meeting_confirmed_window = $2, meeting_confirmed_by = $3, meeting_confirmed_at = NOW(),
           meeting_start_at = $4, meeting_duration_min = $5, meeting_type = $6,
           meeting_proposed_key = NULL
       WHERE id = $1`,
      [conversationId, windowKey, userId, startAt, durationMin, meetingType],
    );

    const sent = await dmService.insertDirectMessageOn(
      client, userId, partnerId, threadLine, null,
      {
        kind: 'system',
        systemMeta: startAt && durationMin
          ? {
              type: 'meeting_confirmed', startAt: startAt.toISOString(), durationMin,
              meetingType: meetingType ?? 'video', joinPath,
              ...(movedFrom ? { movedFrom } : {}),
            }
          : null,
      },
    );
    return { already: false as const, sent, movedFrom };
  });

  if (outcome.already) {
    const same = await requireParticipant(conversationId, userId);
    return buildScheduling(same, userId, rows.rows);
  }

  await announce(conversationId, userId, partnerId, outcome, {
    type: 'meeting_confirmed',
    // The partner had a time in their calendar. A move must not arrive wearing
    // the same words as the original.
    title: outcome.movedFrom ? 'Meeting time changed' : 'Meeting time confirmed',
    body: label,
  });

  // W6: email BOTH people a real calendar invite (.ics + Google link) when an
  // exact time was set. Best-effort — never let an email hiccup fail the confirm.
  if (startAt && durationMin) {
    try {
      const confirmer = byId.get(userId);
      const { generateIcsContent, buildGoogleCalendarUrl } = await import('../calendar/calendar.service');
      const { sendMeetingConfirmedEmail } = await import('../email/email.service');
      const title = 'RSN meeting';
      const threadUrl = `${config.clientUrl}/messages/${conversationId}`;
      const googleUrl = buildGoogleCalendarUrl({ title, startTime: startAt, durationMinutes: durationMin, description: 'A 1:1 meeting arranged on RSN.' });
      for (const uid of [userId, partnerId]) {
        const me = byId.get(uid);
        const other = byId.get(uid === userId ? partnerId : userId);
        if (!me?.email) continue;
        const ics = generateIcsContent({
          title,
          description: `A 1:1 meeting arranged on RSN with ${other?.display_name || 'your match'}.`,
          startTime: startAt,
          durationMinutes: durationMin,
          location: `${config.clientUrl}${joinPath}`,
          // Same meeting, same identity, every copy: both emails and the
          // in-app download. Otherwise accepting the invite and then pressing
          // "Add to calendar" leaves two entries in the same calendar.
          uid: meetingUid(conversationId, startAt),
          organizerName: confirmer?.display_name || 'RSN',
          organizerEmail: confirmer?.email || undefined,
          attendees: people.rows.filter(p => p.email).map(p => ({ name: p.display_name || undefined, email: p.email! })),
        });
        void sendMeetingConfirmedEmail(me.email, me.display_name || 'there', {
          partnerName: other?.display_name || 'your match',
          startAt,
          durationMin,
          recipientTimezone: me.timezone,
          threadUrl,
          googleCalendarUrl: googleUrl,
          icsContent: ics,
          joinUrl: `${config.clientUrl}/meet/${conversationId}?scheduled=1&kind=${meetingType ?? 'video'}`,
          kind: meetingType ?? 'video',
        }).catch(err => logger.warn({ err, uid }, 'meeting-confirmed email failed (non-fatal)'));
      }
    } catch (err) {
      logger.warn({ err, conversationId }, 'meeting-confirmed email dispatch failed (non-fatal)');
    }
  }

  const updated = await requireParticipant(conversationId, userId);
  return buildScheduling(updated, userId, rows.rows);
}
