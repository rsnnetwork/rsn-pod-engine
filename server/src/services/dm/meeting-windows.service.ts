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
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as dmService from './dm.service';

export const DAYPARTS = ['morning', 'afternoon', 'evening'] as const;
export type Daypart = typeof DAYPARTS[number];
export const HORIZON_DAYS = 30; // selections allowed today..today+30

const WINDOW_RE = /^(\d{4})-(\d{2})-(\d{2}):(morning|afternoon|evening)$/;

export interface ConversationScheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: { window: string; byUserId: string; at: Date } | null;
}

// ── Validation (pure — unit-tested directly) ─────────────────────────────────

/**
 * A window key is valid when it parses, is a REAL calendar date, and falls
 * inside [today, today+HORIZON_DAYS] in UTC. `now` injectable for tests.
 */
export function isValidWindowKey(key: string, now = new Date()): boolean {
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
export function windowLabel(key: string): string {
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
}

/** Load the conversation and prove the caller belongs to it. */
async function requireParticipant(conversationId: string, userId: string): Promise<ConversationRow> {
  const r = await query<ConversationRow>(
    `SELECT id, user_a_id, user_b_id,
            meeting_confirmed_window, meeting_confirmed_by, meeting_confirmed_at
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
  return {
    conversationId: conv.id,
    partnerId: conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id,
    mine,
    theirs,
    overlap: mine.filter(w => theirSet.has(w)),
    confirmed: conv.meeting_confirmed_window
      ? { window: conv.meeting_confirmed_window, byUserId: conv.meeting_confirmed_by!, at: conv.meeting_confirmed_at! }
      : null,
  };
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
  const unique = [...new Set(windows)];
  if (unique.length > 21) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Too many windows selected (max 21)');
  }
  for (const w of unique) {
    if (!isValidWindowKey(w)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Invalid or out-of-range window: ${w}`);
    }
  }

  await transaction(async (client) => {
    await client.query(
      `DELETE FROM meeting_availability WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    for (const w of unique) {
      await client.query(
        `INSERT INTO meeting_availability (conversation_id, user_id, window_key)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [conversationId, userId, w],
      );
    }
  });

  const rows = await query<{ user_id: string; window_key: string }>(
    `SELECT user_id, window_key FROM meeting_availability WHERE conversation_id = $1`,
    [conversationId],
  );
  return buildScheduling(conv, userId, rows.rows);
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
): Promise<ConversationScheduling> {
  const conv = await requireParticipant(conversationId, userId);
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

  await query(
    `UPDATE dm_conversations
     SET meeting_confirmed_window = $2, meeting_confirmed_by = $3, meeting_confirmed_at = NOW()
     WHERE id = $1`,
    [conversationId, windowKey, userId],
  );

  const partnerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
  const label = windowLabel(windowKey);

  // The confirmation lives in the thread itself — sendMessage also carries the
  // partner's unread/realtime rails so their open chat updates live.
  try {
    await dmService.sendMessage(userId, partnerId, `📅 Meeting confirmed: ${label}`);
  } catch (err) {
    logger.warn({ err, conversationId }, 'Confirmation message failed (confirmation itself stored)');
  }

  try {
    const inserted = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES (gen_random_uuid(), $1, 'meeting_confirmed', $2, $3, '/messages')
       RETURNING id, created_at`,
      [partnerId, 'Meeting time confirmed', label],
    );
    try {
      const { io } = await import('../../index');
      io.to(`user:${partnerId}`).emit('notification:new', {
        id: inserted.rows[0].id,
        type: 'meeting_confirmed',
        title: 'Meeting time confirmed',
        body: label,
        link: '/messages',
        isRead: false,
        createdAt: inserted.rows[0].created_at,
      });
    } catch { /* socket push non-fatal */ }
  } catch (err) {
    logger.warn({ err, conversationId }, 'Meeting-confirmed notification failed (non-fatal)');
  }

  const updated = await requireParticipant(conversationId, userId);
  return buildScheduling(updated, userId, rows.rows);
}
