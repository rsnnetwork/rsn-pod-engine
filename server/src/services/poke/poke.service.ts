// ─── Poke Service ────────────────────────────────────────────────────────────
//
// Phase G of chat-fix-and-dm-system plan (1 May 2026). Stefan's spec:
// "If you don't know each other or haven't met, you can poke." A poke is a
// low-friction wave hello between two users who haven't yet shared a room
// in any event. Recipient accepts (which seeds an empty conversation and
// unlocks DMs), declines, or ignores.

import { v4 as uuid } from 'uuid';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import config from '../../config';
import { AppError, ConflictError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import type { MeetingFormat } from '@rsn/shared';
import * as blockService from '../block/block.service';
import * as emailService from '../email/email.service';
import * as prefsService from '../notification-prefs/notification-prefs.service';
import { REQUEST_MESSAGE_MAX } from './request-message';
import { requestBellLink } from './request-link';

// Task F2 (23 Jul 2026) — the truthful-loop audit found the poke loop was
// in-app-only: a logged-out founder never learned someone wanted to meet
// them, or that their request had been accepted. Both email types are
// gated by TWO independent kill-switches, mirrored from the closest
// existing patterns in this codebase: the per-user `users.notify_email`
// column (Settings toggle) and the admin `email_config` table (dashboard
// toggle, routes/admin.ts L542-576) — neither of which any send actually
// checked before this. Both must be true for the email to go out.
const POKE_REQUEST_EMAIL_TYPE = 'poke_request';
const POKE_ACCEPTED_EMAIL_TYPE = 'poke_accepted';

/**
 * Email the poke recipient that someone wants to meet them. Fire-and-forget:
 * any failure (missing email, DB hiccup, Resend error) is logged and
 * swallowed here — sendPoke has already succeeded by the time this runs.
 */
async function notifyPokeReceivedByEmail(
  recipientId: string,
  senderName: string,
  introMessage: string | null,
): Promise<void> {
  try {
    const recipientResult = await query<{
      email: string | null; display_name: string | null; notify_email: boolean;
    }>(
      `SELECT email, display_name, notify_email FROM users WHERE id = $1`,
      [recipientId],
    );
    const recipient = recipientResult.rows[0];
    // Global switch (notify_email) > category switch (poke_email): the
    // global gates below are checked first and short-circuit before the
    // finer-grained Settings "Pokes" email toggle is even consulted.
    if (!recipient?.email || !recipient.notify_email) return;
    // Asymmetric gates: notify_email fails closed (user preference), email_config fails open (operational safety).
    if (!(await emailService.isEmailTypeEnabled(POKE_REQUEST_EMAIL_TYPE))) return;
    // pokes-notification-prefs (23 Jul 2026) — Settings "Pokes" email toggle.
    if (!(await prefsService.shouldSendEmail(recipientId, 'poke'))) return;

    await emailService.sendPokeReceivedEmail(recipient.email, recipient.display_name || 'there', {
      senderName,
      introMessage,
      messagesUrl: `${config.clientUrl}/messages`,
    });
  } catch (err) {
    logger.warn({ err, recipientId }, 'Poke received email failed to send (non-fatal)');
  }
}

/**
 * Email the original poke sender that their meeting request was accepted.
 * Same fire-and-forget contract as notifyPokeReceivedByEmail above.
 */
async function notifyPokeAcceptedByEmail(
  senderId: string,
  accepterName: string,
): Promise<void> {
  try {
    const senderResult = await query<{
      email: string | null; display_name: string | null; notify_email: boolean;
    }>(
      `SELECT email, display_name, notify_email FROM users WHERE id = $1`,
      [senderId],
    );
    const sender = senderResult.rows[0];
    // Global switch (notify_email) > category switch (poke_email): the
    // global gates below are checked first and short-circuit before the
    // finer-grained Settings "Pokes" email toggle is even consulted.
    if (!sender?.email || !sender.notify_email) return;
    if (!(await emailService.isEmailTypeEnabled(POKE_ACCEPTED_EMAIL_TYPE))) return;
    // pokes-notification-prefs (23 Jul 2026) — Settings "Pokes" email toggle.
    if (!(await prefsService.shouldSendEmail(senderId, 'poke'))) return;

    await emailService.sendPokeAcceptedEmail(sender.email, sender.display_name || 'there', {
      accepterName,
      messagesUrl: `${config.clientUrl}/messages`,
    });
  } catch (err) {
    logger.warn({ err, senderId }, 'Poke accepted email failed to send (non-fatal)');
  }
}

export interface UserPoke {
  id: string;
  senderId: string;
  recipientId: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  respondedAt: Date | null;
  createdAt: Date;
  preferredFormat: MeetingFormat | null;
}

export interface PokeWithSender extends UserPoke {
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  // 7 Sep 2026 (Ali): the accept surface shows a profile card, so the recipient
  // can see WHO is asking before deciding.
  senderJobTitle: string | null;
  senderCompany: string | null;
}

/**
 * What sending a request returns. 25 Oct 2026: asking someone who has already
 * asked you is a match, so it returns THEIR request, now accepted, with the
 * conversation that opened (`conversationId` is set only then).
 */
export interface SentPoke extends UserPoke {
  conversationId?: string;
}

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The two answers a request can be given. */
type Answer = 'accepted' | 'declined';

/** A request row as the answer paths read it. */
interface PokeRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: UserPoke['status'];
  message: string | null;
  responded_at: Date | null;
  created_at: Date;
  preferred_format: MeetingFormat | null;
}

const POKE_COLUMNS = 'id, sender_id, recipient_id, status, message, responded_at, created_at, preferred_format';

function toUserPoke(r: PokeRow): UserPoke {
  return {
    id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
    status: r.status, message: r.message, respondedAt: r.responded_at,
    createdAt: r.created_at, preferredFormat: r.preferred_format ?? null,
  };
}

/**
 * Answer a request, once (25 Oct 2026). The UPDATE only matches a request that is
 * still pending and was sent to this member, so of two answers racing (two tabs, a
 * double click, Accept against Decline) exactly one changes the row: the other waits
 * on the row lock, then matches nothing. Before this, Decline read the row outside
 * any lock and then overwrote it unconditionally, so an Accept and a Decline at the
 * same moment could leave a "declined" request with an open conversation.
 *
 * The answer that matched nothing is told where the request stands: the same answer
 * again is already done (`won: false`, nothing is repeated), and the other answer is
 * a 409 naming the answer it already has. A request never goes back to pending.
 */
async function claimRequest(
  client: PoolClient,
  pokeId: string,
  userId: string,
  answer: Answer,
): Promise<{ won: boolean; row: PokeRow }> {
  const claimed = await client.query<PokeRow>(
    `UPDATE user_pokes SET status = $3, responded_at = NOW()
      WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
      RETURNING ${POKE_COLUMNS}`,
    [pokeId, userId, answer],
  );
  if (claimed.rows[0]) return { won: true, row: claimed.rows[0] };

  const current = await client.query<PokeRow>(`SELECT ${POKE_COLUMNS} FROM user_pokes WHERE id = $1`, [pokeId]);
  const row = current.rows[0];
  if (!row) throw new NotFoundError('Poke', undefined, "We couldn't find that meeting request.");
  if (row.recipient_id !== userId) {
    const verb = answer === 'accepted' ? 'accept' : 'decline';
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, `Only the person this meeting request was sent to can ${verb} it.`);
  }
  if (row.status === answer) return { won: false, row };
  throw new ConflictError(
    ErrorCodes.MEETING_REQUEST_ALREADY_ANSWERED,
    `You already ${row.status} this request.`,
    { status: row.status },
  );
}

/** Accept the request still pending from one member to another, if there is one (the index allows one per direction). */
async function acceptPendingFrom(client: PoolClient, fromId: string, toId: string): Promise<PokeRow | null> {
  const r = await client.query<PokeRow>(
    `UPDATE user_pokes SET status = 'accepted', responded_at = NOW()
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
      RETURNING ${POKE_COLUMNS}`,
    [fromId, toId],
  );
  return r.rows[0] ?? null;
}

/**
 * The bell row that announced a request, marked read once the request is answered:
 * an answered request is no longer something to act on, and an unread count that
 * keeps counting it is wrong. Found by the link sendPoke wrote on it.
 */
async function markRequestBellRead(client: PoolClient, recipientId: string, pokeId: string): Promise<void> {
  await client.query(
    `UPDATE notifications SET is_read = TRUE
      WHERE user_id = $1 AND type = 'poke' AND link = $2 AND is_read = FALSE`,
    [recipientId, requestBellLink(pokeId)],
  );
}

/** The conversation between two members, if there is one (one per pair). */
async function conversationBetween(client: PoolClient, a: string, b: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM dm_conversations
      WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)
      LIMIT 1`,
    [a, b],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * A request's message as it is stored: ends trimmed, Windows line endings made
 * plain, any run of three or more line breaks (even with spaces between them)
 * folded to one blank line, then capped at REQUEST_MESSAGE_MAX characters (the
 * one cap the route accepts and the reason budget is measured against). The
 * request cards show line breaks (whitespace-pre-line), so without the fold a
 * message made of newlines builds a card hundreds of lines tall. One blank line
 * is kept so a note, a blank line and "Why REASON suggested this: ..." still
 * read as two paragraphs. The cap comes last, so the whole of it goes to what is
 * left. ([^\S\n] is any whitespace except a newline.)
 */
function cleanRequestMessage(message: string | undefined): string | null {
  return message
    ?.trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n(?:[^\S\n]*\n){2,}/g, '\n\n')
    .slice(0, REQUEST_MESSAGE_MAX) || null;
}

/**
 * Send a poke. Auth rules:
 *   - Not self
 *   - Not blocked (either direction)
 *   - No existing encounter (encounter unlocks DMs directly, no need to poke)
 *   - If the recipient has already asked the sender, this request is the answer:
 *     theirs is accepted and the conversation opens (25 Oct 2026, see below)
 *   - No request from sender → recipient that the recipient already declined
 *   - No pending poke from sender → recipient already
 */
export async function sendPoke(
  senderId: string,
  recipientId: string,
  message?: string,
  /** The matching agent this introduction came from, when it came from one
   *  (Wave 2). Stored so the exclusion it creates is scoped to that agent
   *  instead of hiding the person from every other reason to meet them. */
  agentId?: string,
  /** Milestone 1: the format the sender would like (shown to the recipient). */
  preferredFormat?: MeetingFormat,
): Promise<SentPoke> {
  if (senderId === recipientId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, "You can't send a meeting request to yourself.");
  }
  if (await blockService.areBlocked(senderId, recipientId)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, "You can't send a meeting request to this person.");
  }

  // Encounter check: if they've already met, DMs are open — no need to poke.
  const [a, b] = normalizePair(senderId, recipientId);
  const enc = await query<{ id: string }>(
    `SELECT id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 LIMIT 1`,
    [a, b],
  );
  if (enc.rows.length > 0) {
    // What a member is told when the answer is "you two are already connected".
    // The old wording said "poke", which is an internal word nobody outside the
    // codebase uses (22 Sep 2026).
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You can already message them.');
  }

  // 25 Oct 2026: they have already asked to meet you, so wanting to meet them too
  // is a match, as For You promises ("When someone wants to meet you too, it becomes
  // a match"). Before this both requests sat pending side by side, each offering
  // Accept. Checked before the decline rule below: their later request outweighs
  // their earlier "no" to yours.
  const matched = await answerTheirRequest(senderId, recipientId);
  if (matched) return matched;

  // 29 Sep 2026: a "no" stays a no. Before this the person who declined could
  // be asked again from search or a profile as often as the sender liked, each
  // time with a bell and an email. Only sender → recipient is checked: the
  // person who said no can still ask later. It runs after the encounter check
  // on purpose: a pair who declined and later met can already message each
  // other, and should be told that, not reminded of an old decline.
  const declined = await query<{ id: string }>(
    `SELECT id FROM user_pokes
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'declined'
      LIMIT 1`,
    [senderId, recipientId],
  );
  if (declined.rows.length > 0) {
    throw new AppError(
      403,
      ErrorCodes.AUTH_FORBIDDEN,
      'They declined your earlier request, so you cannot send another one.',
    );
  }

  // Recipient existence check (avoid silent FK errors)
  const recipientExists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1`, [recipientId],
  );
  if (recipientExists.rows.length === 0) {
    throw new NotFoundError('User', undefined, 'That member is no longer available.');
  }

  const trimmedMessage = cleanRequestMessage(message);
  const pokeId = uuid();
  try {
    const result = await query<{
      id: string; sender_id: string; recipient_id: string;
      status: 'pending' | 'accepted' | 'declined';
      message: string | null;
      responded_at: Date | null;
      created_at: Date;
      preferred_format: MeetingFormat | null;
    }>(
      `INSERT INTO user_pokes (id, sender_id, recipient_id, message, status, agent_id, preferred_format)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id, sender_id, recipient_id, status, message, responded_at, created_at, preferred_format`,
      [pokeId, senderId, recipientId, trimmedMessage, agentId ?? null, preferredFormat ?? null],
    );
    const r = result.rows[0];
    logger.info({ senderId, recipientId, pokeId: r.id }, 'Poke sent');

    // Fire bell notification for the recipient — same pattern as invites + DMs.
    try {
      const senderResult = await query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`, [senderId],
      );
      const senderName = senderResult.rows[0]?.display_name || 'Someone';

      // pokes-notification-prefs (23 Jul 2026) — Settings "Pokes" bell toggle.
      // Gates the notification row + its live socket push only; the email
      // channel below is independent and gated separately inside
      // notifyPokeReceivedByEmail, so either channel can be turned off
      // without silencing the other.
      if (await prefsService.shouldSendBell(recipientId, 'poke')) {
        const notifId = uuid();
        const notifResult = await query<{ id: string; created_at: Date }>(
          `INSERT INTO notifications (id, user_id, type, title, body, link)
           VALUES ($1, $2, 'poke', $3, $4, $5)
           RETURNING id, created_at`,
          // 4 Sep 2026 (Ali): "asked to meet you" is the product's language, "poke"
          // was ours. The poke id rides in the link so the bell can answer the
          // request in place and accept straight into the conversation.
          [notifId, recipientId, `${senderName} asked to meet you`, trimmedMessage || 'Accept to start chatting.', requestBellLink(pokeId)],
        );

        // Emit via dynamic import of the io instance (same pattern as invites).
        try {
          const { io } = await import('../../index');
          io.to(`user:${recipientId}`).emit('notification:new', {
            id: notifResult.rows[0].id,
            type: 'poke',
            title: `${senderName} asked to meet you`,
            body: trimmedMessage || 'Accept to start chatting.',
            link: requestBellLink(pokeId),
            isRead: false,
            createdAt: notifResult.rows[0].created_at,
          });
          // The bell's own tag, so their bell counter refreshes. The screens
          // (user + invites) are refreshed for both members below, whatever the
          // bell setting is.
          const { emitEntities } = await import('../../realtime/emit');
          const { E } = await import('../../realtime/entities');
          emitEntities(
            io, [recipientId],
            [E.userNotifications(recipientId)],
          ).catch(() => {});
        } catch { /* socket push is non-fatal */ }
      }

      // Task F2 — email the recipient, fire-and-forget, right alongside the
      // socket push above (or independently, when poke_bell is off). Gated
      // on notify_email + email_config + poke_email inside the helper; a
      // rejection there is already caught internally so this can never
      // throw or block the poke response.
      void notifyPokeReceivedByEmail(recipientId, senderName, trimmedMessage);
    } catch (notifErr) {
      logger.warn({ notifErr }, 'Poke notification insert failed (non-fatal)');
    }

    // 29 Sep 2026: both members' screens refresh whatever the recipient's bell
    // setting is. The bell toggle silences the notification, not the data.
    try {
      const { io } = await import('../../index');
      const { emitEntities } = await import('../../realtime/emit');
      const { E } = await import('../../realtime/entities');
      emitEntities(io, [senderId], [E.user(senderId), E.userInvites(senderId)]).catch(() => {});
      emitEntities(io, [recipientId], [E.user(recipientId), E.userInvites(recipientId)]).catch(() => {});
    } catch { /* realtime is non-fatal */ }

    return {
      id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
      status: r.status, message: r.message, respondedAt: r.responded_at,
      createdAt: r.created_at, preferredFormat: r.preferred_format ?? null,
    };
  } catch (err: any) {
    if (err?.code === '23505') {
      // Since 22 Sep the card shows this person as already asked on every
      // search, so a member should not be able to reach this at all. It stays
      // for the race: two tabs, or a card drawn before the first ask landed.
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'You have already asked to meet them — they have not answered yet.');
    }
    throw err;
  }
}

/** The first message of a thread opened by a request that carried no message (Task F3). */
const FALLBACK_INTRO = "You're connected. Say hello.";

/** What accepting a request wrote, for the steps that run once it has committed. */
interface Connected {
  conversationId: string;
  intro: {
    id: string; conversationId: string; fromUserId: string;
    content: string | null; readAt: Date | null; createdAt: Date;
  };
  senderBell: { id: string; title: string; body: string; createdAt: Date; accepterName: string };
}

/**
 * Accept a request whose claim has just won, inside the claim's transaction: the
 * pair can message from now on, the conversation opens with the request's message
 * as its first line, and the sender's bell gets a row. A refusal here rolls the
 * claim back with everything else.
 *
 * Task F1 (23 Jul 2026) — the sender previously heard nothing when their
 * poke was accepted (only a silent fanoutUserEntity badge refresh from the
 * route). A 'poke_accepted' bell notification is now inserted for the
 * sender in the same transaction as the accept, then pushed live via
 * socket ONLY after the transaction commits (announceAccepted) — mirrors
 * sendPoke's notify-then-emit pattern and guarantees a rolled-back accept
 * can never leave a dangling socket push.
 *
 * Task F3 (23 Jul 2026) — a message-less poke used to leave the new
 * conversation with zero messages, which canMessage()'s grandfather
 * clause can never open (dm.service.ts L138-165: the "existing thread
 * with >=1 message" gate never fires, and encounter_history.mutual_meet_again
 * starts false, so `not_mutual` blocks the pair forever). Every accepted
 * poke now seeds a first message — the poke's own message when present,
 * else a fallback line — so the thread is always usable.
 */
async function connectInTx(client: PoolClient, request: PokeRow): Promise<Connected> {
  const senderId = request.sender_id;
  const accepterId = request.recipient_id;

  // 25 Oct 2026: accepting checked neither. Sending already refuses a blocked pair;
  // a request that was waiting when the block came must not open a conversation
  // either, and a member who has closed their account or been suspended cannot be
  // connected to.
  if (await blockService.areBlocked(senderId, accepterId)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, "You can't accept a meeting request from this person.");
  }
  const sender = await client.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [senderId]);
  if (sender.rows[0]?.status !== 'active') {
    throw new NotFoundError('User', undefined, 'That member is no longer available.');
  }

  // Seed encounter_history so canMessage() returns true from now on.
  // mutual_meet_again stays false until they actually rate each other.
  const [a, b] = normalizePair(senderId, accepterId);
  await client.query(
    `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at)
     VALUES ($1, $2, $3, 0, NOW())
     ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
    [uuid(), a, b],
  );

  // Create the conversation row.
  const convResult = await client.query<{ id: string }>(
    `INSERT INTO dm_conversations (id, user_a_id, user_b_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_a_id, user_b_id) DO UPDATE
       SET user_a_deleted_at = NULL, user_b_deleted_at = NULL
     RETURNING id`,
    [uuid(), a, b],
  );
  const conversationId = convResult.rows[0].id;

  // REASON Phase 2 (19 Jul) — "we introduce them to each other": the poke's
  // message (for platform matches, the composed introduction) becomes the
  // FIRST message of the new thread instead of dying with the accepted poke.
  // Pre-fix the chat opened cold and the intro text was lost. Sender-authored
  // (it is their expressed interest), same transaction so accept+intro are
  // atomic.
  //
  // Task F3 — message-less pokes used to skip this block entirely, leaving
  // a 0-message conversation canMessage() can never open. Now a fallback
  // line seeds the thread instead, still sender-authored, so the grandfather
  // clause opens it from the first read.
  const introText = request.message && request.message.trim().length > 0
    ? request.message.trim().slice(0, 4000)
    : FALLBACK_INTRO;
  const introInsert = await client.query<{
    id: string; conversation_id: string; from_user_id: string;
    content: string | null; read_at: Date | null; created_at: Date;
  }>(
    `INSERT INTO direct_messages (id, conversation_id, from_user_id, content)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id, from_user_id, content, read_at, created_at`,
    [uuid(), conversationId, senderId, introText],
  );
  const introRow = introInsert.rows[0];
  await client.query(
    `UPDATE dm_conversations SET last_message_at = NOW() WHERE id = $1`,
    [conversationId],
  );

  // 25 Oct 2026: when the accepter had asked the sender too, that request is answered
  // by this one: one connection, one first message, one bell. Left pending, it went on
  // offering Accept on both screens, and accepting it ran all of this a second time.
  const askedBack = await acceptPendingFrom(client, accepterId, senderId);

  // Task F1 — bell notification for the SENDER, inserted in the same
  // transaction as the accept so it can never exist without a
  // corresponding accepted poke (and vice versa).
  const accepterResult = await client.query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE id = $1`, [accepterId],
  );
  const accepterName = accepterResult.rows[0]?.display_name || 'Someone';
  const title = `${accepterName} accepted your meeting request`;
  const body = introText.slice(0, 120);
  const notifId = uuid();
  // Deliberately INSIDE this transaction, not best-effort — it's atomic
  // with the accept by design (see the Task F1 comment above this
  // function) so this can never exist without a corresponding accepted
  // poke. Do not move it to a post-commit "fire and forget" block.
  //
  // pokes-notification-prefs (23 Jul 2026) — also deliberately NOT gated
  // by shouldSendBell(poke_bell): this is the DoD-critical "clear
  // notification" telling the sender their poke landed, same tradeoff as
  // the F1 comment above. Only the poke_accepted EMAIL (post-commit,
  // in announceAccepted) respects the Settings "Pokes" toggle.
  const notifResult = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications (id, user_id, type, title, body, link)
     VALUES ($1, $2, 'poke_accepted', $3, $4, $5)
     RETURNING id, created_at`,
    // Straight into the conversation that just opened, not the inbox.
    [notifId, senderId, title, body, `/messages/${conversationId}`],
  );

  // The bell rows that announced the requests now answered stop asking for an answer.
  await markRequestBellRead(client, accepterId, request.id);
  if (askedBack) await markRequestBellRead(client, senderId, askedBack.id);

  logger.info({ pokeId: request.id, accepterId, conversationId, askedBack: askedBack?.id ?? null }, 'Poke accepted');
  return {
    conversationId,
    intro: {
      id: introRow.id,
      conversationId: introRow.conversation_id,
      fromUserId: introRow.from_user_id,
      content: introRow.content,
      readAt: introRow.read_at,
      createdAt: introRow.created_at,
    },
    senderBell: { id: notifResult.rows[0].id, title, body, createdAt: notifResult.rows[0].created_at, accepterName },
  };
}

/**
 * After an accept has committed: the sender's bell rings live, the first message
 * reaches both inboxes, and the sender is emailed. Post-commit only — mirrors
 * sendPoke's ordering so a socket push (or an email) can never fire for a
 * transaction that ended up rolled back. Each step is best-effort.
 */
async function announceAccepted(request: PokeRow, done: Connected): Promise<void> {
  const senderId = request.sender_id;
  try {
    const { io } = await import('../../index');
    io.to(`user:${senderId}`).emit('notification:new', {
      id: done.senderBell.id,
      type: 'poke_accepted',
      title: done.senderBell.title,
      body: done.senderBell.body,
      link: `/messages/${done.conversationId}`,
      isRead: false,
      createdAt: done.senderBell.createdAt,
    });
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    emitEntities(
      io, [senderId],
      [E.userNotifications(senderId), E.userInvites(senderId)],
    ).catch((err) => logger.warn({ err, senderId }, 'Poke-accepted entity fanout failed (non-fatal)'));
  } catch (err) {
    logger.warn({ err, senderId }, 'Poke-accepted socket push failed (non-fatal)');
  }

  // 7 Sep 2026 — fan the intro out to BOTH participants so the SENDER's inbox
  // gains the new conversation live (pre-fix only the sender's bell fired and
  // their Messages list stayed empty until a manual refresh) and the accepter's
  // thread updates on every device. notify:false: the poke_accepted bell above
  // is the notification, so no duplicate "sent you a message" bell.
  try {
    const { io } = await import('../../index');
    const { broadcastDmMessage } = await import('../orchestration/handlers/dm-handlers');
    await broadcastDmMessage(io, senderId, request.recipient_id, done.conversationId, done.intro, { notify: false });
  } catch (err) {
    logger.warn({ err, conversationId: done.conversationId }, 'Poke-accepted DM fan-out failed (non-fatal)');
  }

  // Task F2 — email the original sender, fire-and-forget, right alongside
  // the socket push above. Gated on notify_email + email_config inside the
  // helper; internally self-catching, so it can never throw here.
  void notifyPokeAcceptedByEmail(senderId, done.senderBell.accepterName);
}

/**
 * Asking someone who has already asked you (25 Oct 2026): their request is
 * accepted instead of a second one being added beside it. Returns their request,
 * now accepted, with the conversation that opened; null when they have not asked,
 * and the caller sends a request as usual.
 */
async function answerTheirRequest(senderId: string, recipientId: string): Promise<SentPoke | null> {
  const matched = await transaction(async (client) => {
    const theirs = await acceptPendingFrom(client, recipientId, senderId);
    if (!theirs) return null;
    return { row: theirs, connected: await connectInTx(client, theirs) };
  });
  if (!matched) return null;

  await announceAccepted(matched.row, matched.connected);
  // A match changes both members' screens and bells, as a sent request and an accept each do.
  try {
    const { io } = await import('../../index');
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    await Promise.all([senderId, recipientId].map((id) =>
      emitEntities(io, [id], [E.user(id), E.userInvites(id), E.userNotifications(id)])));
  } catch (err) {
    logger.warn({ err, senderId, recipientId }, 'Match entity fanout failed (non-fatal)');
  }
  return { ...toUserPoke(matched.row), conversationId: matched.connected.conversationId };
}

/**
 * Accept a request. Caller must be the recipient. A claim (see claimRequest):
 * the first accept opens the conversation (connectInTx); an accept of a request
 * that is already accepted repeats nothing and answers with the same
 * conversation, so a stale bell or card lands in the thread; an accept of a
 * declined request is a 409.
 */
export async function acceptPoke(
  pokeId: string,
  userId: string,
): Promise<{ poke: UserPoke; conversationId: string | null }> {
  const outcome = await transaction(async (client) => {
    const claim = await claimRequest(client, pokeId, userId, 'accepted');
    if (!claim.won) {
      const conversationId = await conversationBetween(client, claim.row.sender_id, claim.row.recipient_id);
      return { row: claim.row, conversationId, connected: null };
    }
    const connected = await connectInTx(client, claim.row);
    return { row: claim.row, conversationId: connected.conversationId, connected };
  });

  if (outcome.connected) await announceAccepted(outcome.row, outcome.connected);
  return { poke: toUserPoke(outcome.row), conversationId: outcome.conversationId };
}

/**
 * Decline a request. Caller must be the recipient. A claim (see claimRequest):
 * declining twice is done once, and declining an accepted request is a 409.
 * Nobody is notified: that is deliberate (a "no" is never pushed at the sender).
 * Only the decliner's own bell row for the request is marked read.
 */
export async function declinePoke(pokeId: string, userId: string): Promise<UserPoke> {
  const row = await transaction(async (client) => {
    const claim = await claimRequest(client, pokeId, userId, 'declined');
    if (claim.won) await markRequestBellRead(client, userId, pokeId);
    return claim.row;
  });
  return toUserPoke(row);
}

/**
 * List pending pokes I've received. Includes sender display info so the
 * inbox UI can render each one with avatar + name.
 */
export async function listReceivedPokes(userId: string): Promise<PokeWithSender[]> {
  const result = await query<{
    id: string; sender_id: string; recipient_id: string; status: 'pending' | 'accepted' | 'declined';
    message: string | null; responded_at: Date | null; created_at: Date;
    preferred_format: MeetingFormat | null;
    display_name: string | null; avatar_url: string | null;
    job_title: string | null; company: string | null;
  }>(
    `SELECT p.id, p.sender_id, p.recipient_id, p.status, p.message,
            p.responded_at, p.created_at, p.preferred_format,
            u.display_name, u.avatar_url, u.job_title, u.company
     FROM user_pokes p
     JOIN users u ON u.id = p.sender_id
     WHERE p.recipient_id = $1 AND p.status = 'pending'
       -- 25 Oct 2026: only requests that can still be answered. Accepting refuses a
       -- pair a block stands between (either way) and a sender who is no longer
       -- active, so the card would offer an Accept that cannot work.
       AND u.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = $1 AND b.blocked_id = p.sender_id)
             OR (b.blocker_id = p.sender_id AND b.blocked_id = $1))
     ORDER BY p.created_at DESC`,
    [userId],
  );
  return result.rows.map(r => ({
    id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
    status: r.status, message: r.message, respondedAt: r.responded_at,
    createdAt: r.created_at, preferredFormat: r.preferred_format ?? null,
    senderDisplayName: r.display_name,
    senderAvatarUrl: r.avatar_url,
    senderJobTitle: r.job_title,
    senderCompany: r.company,
  }));
}

export interface PokeWith {
  id: string;
  status: 'pending' | 'accepted' | 'declined';
  /** True when the caller sent it, false when they received it. */
  sentByMe: boolean;
}

/** Where a request stands, plus the thread if it turned into one. */
export interface PokeState extends PokeWith {
  otherUserId: string;
  /** Set once accepted, so a link to an answered request can go somewhere. */
  conversationId: string | null;
}

/**
 * One request, for whoever is part of it. The screens that open on a request id
 * read the PENDING list and pick it out, so an answered one — accepted in
 * another tab, or reached again from an old email — showed a dead end telling
 * the member to go and find the conversation themselves (22 Sep 2026). With
 * this they can be sent to it.
 *
 * Refuses anyone who is not one of the two people, rather than 404, so it
 * cannot be used to probe which request ids exist.
 */
export async function getPokeState(pokeId: string, userId: string): Promise<PokeState | null> {
  const r = await query<{
    id: string; status: PokeState['status']; sender_id: string; recipient_id: string;
    conversation_id: string | null;
  }>(
    `SELECT p.id, p.status, p.sender_id, p.recipient_id,
            (SELECT c.id FROM dm_conversations c
              WHERE (c.user_a_id = p.sender_id AND c.user_b_id = p.recipient_id)
                 OR (c.user_a_id = p.recipient_id AND c.user_b_id = p.sender_id)
              LIMIT 1) AS conversation_id
       FROM user_pokes p
      WHERE p.id = $1 AND (p.sender_id = $2 OR p.recipient_id = $2)`,
    [pokeId, userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    sentByMe: row.sender_id === userId,
    otherUserId: row.sender_id === userId ? row.recipient_id : row.sender_id,
    conversationId: row.status === 'accepted' ? row.conversation_id : null,
  };
}

/**
 * Where a meeting request between these two stands, newest first — either
 * direction. The profile showed a dead "Message — meet first" button to
 * someone who had ALREADY been asked (or who had asked YOU), which reads as a
 * wall when the way through is right there. The page needs the state to say so.
 */
export async function getPokeWith(userId: string, otherId: string): Promise<PokeWith | null> {
  const r = await query<{ id: string; status: PokeWith['status']; sender_id: string }>(
    `SELECT id, status, sender_id FROM user_pokes
      WHERE (sender_id = $1 AND recipient_id = $2)
         OR (sender_id = $2 AND recipient_id = $1)
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, otherId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, status: row.status, sentByMe: row.sender_id === userId } : null;
}

/**
 * Has the current user already poked the target with a pending poke?
 * Used by the profile UI to render Poke vs Pending state.
 */
export async function hasPendingPoke(senderId: string, recipientId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM user_pokes
     WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending' LIMIT 1`,
    [senderId, recipientId],
  );
  return result.rows.length > 0;
}
