// ─── Event chat (26 Oct 2026) ────────────────────────────────────────────────
//
// An event's chat is written to Postgres as it is sent, before anyone receives it, and kept as long as the
// event exists (it goes only with a permanent delete of the event). There is no copy in memory or in Redis:
// the live event's history, the completed event's page and the reactions all read event_chat_messages, so a
// restart or a deploy in the middle of an event loses nothing.
//
// Who reads it (canReadEventChat):
//   - the event's host, its co-hosts and everyone who took part (joined, not removed; those who left early
//     included): every lobby message and the room messages they were sent;
//   - someone registered for the event whose socket is in its room while the chat is open (the pre-event
//     lobby, before joined_at is set, and the live event);
//   - a platform admin: lobby messages only (room messages are private to their room; reports cover them);
//   - nobody else: registered but never joined, other pod members, a removed participant.
// A blocked author is left out both ways on every read, and skipped when a message is sent.

import { query, transaction } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, UserRole, hasRoleAtLeast } from '@rsn/shared';
import type { EventChatMessage, EventChatPage, EventChatScope, LiveChatMessage } from '@rsn/shared';

/** The reactions the live chat offers, by name (the client draws them). */
export const CHAT_REACTION_EMOJIS = ['heart', 'clap', 'thumbs_up'] as const;
/** The longest message in characters; the handler cuts a message to it and the table refuses a longer one. */
export const EVENT_CHAT_MAX_LENGTH = 500;
/** At most this many messages from one member in any window. */
export const CHAT_SEND_LIMIT = { max: 10, windowMs: 10_000 } as const;
/** History requests and reactions each cost database work: at most this many of each per member in any window. */
export const CHAT_READ_LIMIT = { max: 20, windowMs: 10_000 } as const;
/** The longest room id stored with a room message. A client names its room (presence:room_joined); real ids are far shorter. */
export const EVENT_CHAT_ROOM_ID_MAX = 200;

export const EVENT_CHAT_FORBIDDEN = 'Only people who took part in this event can read its chat.';
export const EVENT_CHAT_CLOSED = 'This event has ended, so its chat is closed.';
export const EVENT_CHAT_TOO_FAST = 'You are sending messages too quickly. Wait a few seconds, then try again.';
export const EVENT_CHAT_SEND_FAILED = 'Your message could not be sent. Try again.';
const EVENT_CHAT_DELETE_FORBIDDEN = 'Only the person who wrote this message, a host of this event or an admin can delete it.';
const FORMER_MEMBER = 'Former member';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;
/** The live panel keeps the last 200 messages; the history sent on joining matches it. */
const LIVE_HISTORY_LIMIT = 200;
const SENDER_NAME_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^(\d{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 'all': every lobby message and the room messages the viewer was sent. 'lobby': lobby messages only. */
export type EventChatAccess = 'all' | 'lobby';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The chat is open from the pre-event lobby until the event is completed or cancelled. */
export function isChatClosed(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled';
}

function isAdminRole(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

// ── Who may read ─────────────────────────────────────────────────────────────

interface AccessFacts {
  status: string;
  is_host: boolean;
  is_cohost: boolean;
  participant_status: string | null;
  joined: boolean;
}

/**
 * What the viewer may read of the event's chat, or null for nothing. `inSessionRoom`: the viewer's socket is
 * in the event's socket room, which admits someone registered for the event while the chat is open. Throws
 * NotFoundError for an event that does not exist.
 */
export async function canReadEventChat(
  viewerId: string,
  viewerRole: string | undefined,
  sessionId: string,
  opts: { inSessionRoom?: boolean } = {},
): Promise<EventChatAccess | null> {
  const result = await query<AccessFacts>(
    `SELECT s.status::text AS status,
            s.host_user_id = $2 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            p.status::text AS participant_status,
            p.joined_at IS NOT NULL AS joined
       FROM sessions s
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.user_id = $2
      WHERE s.id = $1`,
    [sessionId, viewerId],
  );
  const facts = result.rows[0];
  if (!facts) throw new NotFoundError('Session', sessionId, 'This event could not be found.');
  const admin = isAdminRole(viewerRole);
  if (facts.is_host) return 'all';
  // A kick is final: a removed member reads nothing, even as a co-host or from a socket still in the room.
  if (facts.participant_status === 'removed') return admin ? 'lobby' : null;
  if (facts.is_cohost || facts.joined) return 'all';
  // The room counts only for someone registered for the event (the pre-event lobby has no joined_at yet):
  // the join admits only the people the event admits (H1), but someone refused only because the event is
  // full still joins its room without a participant row.
  if (opts.inSessionRoom && facts.participant_status !== null && !isChatClosed(facts.status)) return 'all';
  return admin ? 'lobby' : null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface ChatRow {
  id: string;
  sender_id: string | null;
  sender_name: string;
  sender_is_host: boolean;
  scope: EventChatScope;
  room_id: string | null;
  content: string;
  created_at: Date | string;
  sender_status: string | null;
  reactions: Record<string, string[]> | null;
}

/** A message with its author's current account status and its reactions (each with who gave it). */
const ROW_COLUMNS = `
  m.id, m.sender_id, m.sender_name, m.sender_is_host, m.scope, m.room_id, m.content, m.created_at,
  u.status::text AS sender_status,
  COALESCE((
    SELECT json_object_agg(x.emoji, x.user_ids)
      FROM (SELECT r.emoji, array_agg(r.user_id ORDER BY r.created_at, r.user_id) AS user_ids
              FROM event_chat_reactions r
             WHERE r.message_id = m.id
             GROUP BY r.emoji) x
  ), '{}'::json) AS reactions`;

/** Newest first: the messages the viewer may see, optionally before a cursor position. */
async function visibleRows(
  sessionId: string,
  viewerId: string,
  access: EventChatAccess,
  opts: { before?: { at: Date; id: string } | null; limit: number },
): Promise<ChatRow[]> {
  const params: unknown[] = [sessionId, viewerId, access === 'all'];
  let keyset = '';
  if (opts.before) {
    params.push(opts.before.at, opts.before.id);
    keyset = 'AND (m.created_at, m.id) < ($4, $5::uuid)';
  }
  params.push(opts.limit);
  const result = await query<ChatRow>(
    `SELECT ${ROW_COLUMNS}
       FROM event_chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.session_id = $1
        AND m.deleted_at IS NULL
        AND (m.scope = 'lobby' OR ($3::boolean AND m.audience_ids @> ARRAY[$2::uuid]))
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = m.sender_id)
              OR (b.blocker_id = m.sender_id AND b.blocked_id = $2))
        ${keyset}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

const iso = (at: Date | string) => new Date(at).toISOString();

/** An author whose account is closed (or gone) is named "Former member", with no id to link to. */
const isFormerMember = (row: ChatRow) => row.sender_id === null || row.sender_status !== 'active';

function toEventChatMessage(row: ChatRow): EventChatMessage {
  const former = isFormerMember(row);
  const reactions: Record<string, number> = {};
  for (const [emoji, userIds] of Object.entries(row.reactions ?? {})) reactions[emoji] = userIds.length;
  return {
    id: row.id,
    senderId: former ? null : row.sender_id,
    senderName: former ? FORMER_MEMBER : row.sender_name,
    senderIsHost: row.sender_is_host,
    scope: row.scope,
    content: row.content,
    createdAt: iso(row.created_at),
    reactions,
  };
}

function toLiveMessage(row: ChatRow): LiveChatMessage {
  return {
    id: row.id,
    userId: row.sender_id ?? '',
    displayName: isFormerMember(row) ? FORMER_MEMBER : row.sender_name,
    message: row.content,
    timestamp: iso(row.created_at),
    scope: row.scope,
    isHost: row.sender_is_host,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    reactions: row.reactions ?? {},
  };
}

function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (cursor === undefined) return null;
  const m = CURSOR.exec(cursor);
  if (!m) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'That page of the chat could not be found.');
  return { at: new Date(Number(m[1])), id: m[2].toLowerCase() };
}

/**
 * A page of the event's chat for the viewer (the completed event's page). Newest first across pages, oldest to
 * newest within a page. Throws ForbiddenError with the sentence the page shows when the viewer may not read it.
 */
export async function listEventChat(
  sessionId: string,
  viewer: { id: string; role?: string },
  opts: { cursor?: string; limit?: number } = {},
): Promise<EventChatPage> {
  const before = parseCursor(opts.cursor);
  const access = await canReadEventChat(viewer.id, viewer.role, sessionId);
  if (!access) throw new ForbiddenError(EVENT_CHAT_FORBIDDEN);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? PAGE_DEFAULT), 1), PAGE_MAX);
  const rows = await visibleRows(sessionId, viewer.id, access, { before, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const oldest = page[page.length - 1];
  return {
    messages: page.reverse().map(toEventChatMessage),
    nextCursor: rows.length > limit && oldest ? `${new Date(oldest.created_at).getTime()}_${oldest.id}` : null,
  };
}

/** The chat so far as the live event's socket carries it: the last 200 the viewer may see, oldest first. */
export async function listLiveChatHistory(
  sessionId: string,
  viewerId: string,
  access: EventChatAccess,
): Promise<LiveChatMessage[]> {
  const rows = await visibleRows(sessionId, viewerId, access, { limit: LIVE_HISTORY_LIMIT });
  return rows.reverse().map(toLiveMessage);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewEventChatMessage {
  sessionId: string;
  senderId: string;
  senderName: string;
  senderIsHost: boolean;
  scope: EventChatScope;
  content: string;
  /** A room message: the LiveKit room it was said in (none when the sender was in no room the server tracks). */
  roomId?: string | null;
  matchId?: string | null;
  /** A room message: everyone it is delivered to. The sender is always added. */
  audienceIds?: string[] | null;
  /** Optional idempotency key from the client: a retry with the same key stores nothing new. */
  clientId?: string | null;
}

/**
 * Stores a message before anyone receives it and returns it in the socket's shape. `created` is false when its
 * clientId had been stored already (the earlier message is returned, and nothing should be sent again).
 * Throws AppError EVENT_ENDED when the event's chat is closed: nothing is stored.
 */
export async function persistEventChatMessage(
  input: NewEventChatMessage,
): Promise<{ message: LiveChatMessage; created: boolean }> {
  const room = input.scope === 'room';
  const roomId = room && input.roomId ? input.roomId : null;
  // A client names its own room (presence:room_joined), so the match is looked up in this event, and an id
  // that is not one is stored as none rather than failing the message.
  const matchId = room && isUuid(input.matchId) ? input.matchId : null;
  const audience = room ? [...new Set([input.senderId, ...(input.audienceIds ?? [])])] : null;
  const senderName = [...input.senderName].slice(0, SENDER_NAME_MAX).join('');
  const clientId = input.clientId ?? null;
  const inserted = await query<{ id: string; created_at: Date }>(
    `INSERT INTO event_chat_messages
       (session_id, sender_id, sender_name, sender_is_host, scope, room_id, match_id, audience_ids, content, client_id)
     SELECT s.id, $2::uuid, $3::text, $4::boolean, $5::text, $6::text, m.id, $8::uuid[], $9::text, $10::uuid
       FROM sessions s
       LEFT JOIN matches m ON m.id = $7::uuid AND m.session_id = s.id
      WHERE s.id = $1 AND s.status NOT IN ('completed', 'cancelled')
     ON CONFLICT (session_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING id, created_at`,
    [input.sessionId, input.senderId, senderName, input.senderIsHost, input.scope, roomId, matchId, audience,
      input.content, clientId],
  );
  const row = inserted.rows[0];
  if (row) {
    return {
      created: true,
      message: {
        id: row.id,
        userId: input.senderId,
        displayName: senderName,
        message: input.content,
        timestamp: iso(row.created_at),
        scope: input.scope,
        isHost: input.senderIsHost,
        ...(roomId ? { roomId } : {}),
        reactions: {},
      },
    };
  }
  if (clientId) {
    const earlier = await query<ChatRow>(
      `SELECT ${ROW_COLUMNS}
         FROM event_chat_messages m
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.session_id = $1 AND m.sender_id = $2 AND m.client_id = $3`,
      [input.sessionId, input.senderId, clientId],
    );
    if (earlier.rows[0]) return { created: false, message: toLiveMessage(earlier.rows[0]) };
  }
  throw new AppError(409, ErrorCodes.EVENT_ENDED, EVENT_CHAT_CLOSED);
}

/**
 * Gives or takes back a member's reaction on a message they can see, in an event whose chat is open. Returns
 * every reaction on the message (each with who gave it) and who the message reached, so the update goes to the
 * same people; null when the member cannot react to it.
 */
export async function toggleEventChatReaction(input: {
  sessionId: string;
  messageId: string;
  userId: string;
  emoji: string;
}): Promise<{ scope: EventChatScope; audienceIds: string[] | null; reactions: Record<string, string[]> } | null> {
  if (!(CHAT_REACTION_EMOJIS as readonly string[]).includes(input.emoji)) return null;
  return transaction(async (client) => {
    const message = await client.query<{ scope: EventChatScope; audience_ids: string[] | null }>(
      `SELECT m.scope, m.audience_ids
         FROM event_chat_messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.id = $1 AND m.session_id = $2
          AND m.deleted_at IS NULL
          AND s.status NOT IN ('completed', 'cancelled')
          AND (m.scope = 'lobby' OR m.audience_ids @> ARRAY[$3::uuid])
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $3 AND b.blocked_id = m.sender_id)
                OR (b.blocker_id = m.sender_id AND b.blocked_id = $3))`,
      [input.messageId, input.sessionId, input.userId],
    );
    const found = message.rows[0];
    if (!found) return null;
    const taken = await client.query(
      `DELETE FROM event_chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [input.messageId, input.userId, input.emoji],
    );
    if (!taken.rowCount) {
      await client.query(
        `INSERT INTO event_chat_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [input.messageId, input.userId, input.emoji],
      );
    }
    const all = await client.query<{ emoji: string; user_ids: string[] }>(
      `SELECT emoji, array_agg(user_id ORDER BY created_at, user_id) AS user_ids
         FROM event_chat_reactions
        WHERE message_id = $1
        GROUP BY emoji`,
      [input.messageId],
    );
    const reactions: Record<string, string[]> = {};
    for (const r of all.rows) reactions[r.emoji] = r.user_ids;
    return { scope: found.scope, audienceIds: found.audience_ids, reactions };
  });
}

/**
 * Takes a message down: hidden from every read, kept with who did it. Its author, the event's host or a
 * co-host, or a platform admin may. A message already taken down is a quiet `{ deleted: false }`.
 */
export async function deleteEventChatMessage(
  sessionId: string,
  messageId: string,
  actor: { id: string; role?: string },
): Promise<{ deleted: boolean }> {
  return transaction(async (client) => {
    const result = await client.query<{ sender_id: string | null; deleted_at: Date | null; host_user_id: string; is_cohost: boolean }>(
      `SELECT m.sender_id, m.deleted_at, s.host_user_id,
              EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = m.session_id AND c.user_id = $3) AS is_cohost
         FROM event_chat_messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.id = $1 AND m.session_id = $2
        FOR UPDATE OF m`,
      [messageId, sessionId, actor.id],
    );
    const message = result.rows[0];
    if (!message) throw new NotFoundError('Message', messageId, 'This message could not be found.');
    const allowed = message.sender_id === actor.id || message.host_user_id === actor.id
      || message.is_cohost || isAdminRole(actor.role);
    if (!allowed) throw new ForbiddenError(EVENT_CHAT_DELETE_FORBIDDEN);
    if (message.deleted_at) return { deleted: false };
    await client.query(
      `UPDATE event_chat_messages SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`,
      [messageId, actor.id],
    );
    return { deleted: true };
  });
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** Everyone the member has blocked or been blocked by: they are skipped when the member's message is sent. */
export async function chatBlockedUserIds(userId: string): Promise<Set<string>> {
  const result = await query<{ other_id: string }>(
    `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS other_id
       FROM user_blocks
      WHERE blocker_id = $1 OR blocked_id = $1`,
    [userId],
  );
  return new Set(result.rows.map((r) => r.other_id));
}

/**
 * A sliding window per member: at most `max` accepted sends in any `windowMs`; a refused attempt takes no slot.
 * Kept in this process's memory (production runs one instance); a member idle for a whole window is dropped.
 */
export function createSendLimiter(max: number, windowMs: number): (userId: string, now?: number) => boolean {
  const sent = new Map<string, number[]>();
  let lastSweep = 0;
  return (userId, now = Date.now()) => {
    if (now - lastSweep >= windowMs) {
      for (const [id, times] of sent) {
        if (now - times[times.length - 1] >= windowMs) sent.delete(id);
      }
      lastSweep = now;
    }
    const recent = (sent.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      sent.set(userId, recent);
      return false;
    }
    recent.push(now);
    sent.set(userId, recent);
    return true;
  };
}

/** The live chat's limit: 10 messages per member in any 10 seconds. */
export const takeChatSendSlot = createSendLimiter(CHAT_SEND_LIMIT.max, CHAT_SEND_LIMIT.windowMs);
/** chat:request_history: 20 per member in any 10 seconds; one over is dropped without a word. */
export const takeChatHistorySlot = createSendLimiter(CHAT_READ_LIMIT.max, CHAT_READ_LIMIT.windowMs);
/** chat:react: 20 per member in any 10 seconds; one over is dropped without a word. */
export const takeChatReactSlot = createSendLimiter(CHAT_READ_LIMIT.max, CHAT_READ_LIMIT.windowMs);
