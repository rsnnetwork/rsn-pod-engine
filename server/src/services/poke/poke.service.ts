// ─── Poke Service ────────────────────────────────────────────────────────────
//
// Phase G of chat-fix-and-dm-system plan (1 May 2026). Stefan's spec:
// "If you don't know each other or haven't met, you can poke." A poke is a
// low-friction wave hello between two users who haven't yet shared a room
// in any event. Recipient accepts (which seeds an empty conversation and
// unlocks DMs), declines, or ignores.

import { v4 as uuid } from 'uuid';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import config from '../../config';
import { AppError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import * as blockService from '../block/block.service';
import * as emailService from '../email/email.service';

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
    if (!recipient?.email || !recipient.notify_email) return;
    // Asymmetric gates: notify_email fails closed (user preference), email_config fails open (operational safety).
    if (!(await emailService.isEmailTypeEnabled(POKE_REQUEST_EMAIL_TYPE))) return;

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
    if (!sender?.email || !sender.notify_email) return;
    if (!(await emailService.isEmailTypeEnabled(POKE_ACCEPTED_EMAIL_TYPE))) return;

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
}

export interface PokeWithSender extends UserPoke {
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
}

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Send a poke. Auth rules:
 *   - Not self
 *   - Not blocked (either direction)
 *   - No existing encounter (encounter unlocks DMs directly, no need to poke)
 *   - No pending poke from sender → recipient already
 */
export async function sendPoke(
  senderId: string,
  recipientId: string,
  message?: string,
): Promise<UserPoke> {
  if (senderId === recipientId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot poke yourself');
  }
  if (await blockService.areBlocked(senderId, recipientId)) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Cannot poke this user');
  }

  // Encounter check: if they've already met, DMs are open — no need to poke.
  const [a, b] = normalizePair(senderId, recipientId);
  const enc = await query<{ id: string }>(
    `SELECT id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 LIMIT 1`,
    [a, b],
  );
  if (enc.rows.length > 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You can already DM this user — no need to poke');
  }

  // Recipient existence check (avoid silent FK errors)
  const recipientExists = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1`, [recipientId],
  );
  if (recipientExists.rows.length === 0) {
    throw new NotFoundError('User', recipientId);
  }

  const trimmedMessage = message?.trim().slice(0, 500) || null;
  const pokeId = uuid();
  try {
    const result = await query<{
      id: string; sender_id: string; recipient_id: string;
      status: 'pending' | 'accepted' | 'declined';
      message: string | null;
      responded_at: Date | null;
      created_at: Date;
    }>(
      `INSERT INTO user_pokes (id, sender_id, recipient_id, message, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, sender_id, recipient_id, status, message, responded_at, created_at`,
      [pokeId, senderId, recipientId, trimmedMessage],
    );
    const r = result.rows[0];
    logger.info({ senderId, recipientId, pokeId: r.id }, 'Poke sent');

    // Fire bell notification for the recipient — same pattern as invites + DMs.
    try {
      const senderResult = await query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`, [senderId],
      );
      const senderName = senderResult.rows[0]?.display_name || 'Someone';
      const notifId = uuid();
      const notifResult = await query<{ id: string; created_at: Date }>(
        `INSERT INTO notifications (id, user_id, type, title, body, link)
         VALUES ($1, $2, 'poke', $3, $4, $5)
         RETURNING id, created_at`,
        [notifId, recipientId, `${senderName} poked you`, trimmedMessage || 'They want to connect — accept to start chatting.', '/messages'],
      );

      // Task F2 — email the recipient, fire-and-forget, right alongside the
      // socket push below. Gated on notify_email + email_config inside the
      // helper; a rejection there is already caught internally so this can
      // never throw or block the poke response.
      void notifyPokeReceivedByEmail(recipientId, senderName, trimmedMessage);

      // Emit via dynamic import of the io instance (same pattern as invites).
      try {
        const { io } = await import('../../index');
        io.to(`user:${recipientId}`).emit('notification:new', {
          id: notifResult.rows[0].id,
          type: 'poke',
          title: `${senderName} poked you`,
          body: trimmedMessage || 'They want to connect — accept to start chatting.',
          link: '/messages',
          isRead: false,
          createdAt: notifResult.rows[0].created_at,
        });
        // Phase 2 dual-emit — notifications + invites for the recipient
        // so their bell counter / received-invites surfaces refresh.
        const { emitEntities } = await import('../../realtime/emit');
        const { E } = await import('../../realtime/entities');
        emitEntities(
          io, [recipientId],
          [E.userNotifications(recipientId), E.userInvites(recipientId)],
        ).catch(() => {});
      } catch { /* socket push is non-fatal */ }
    } catch (notifErr) {
      logger.warn({ notifErr }, 'Poke notification insert failed (non-fatal)');
    }

    return {
      id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
      status: r.status, message: r.message, respondedAt: r.responded_at,
      createdAt: r.created_at,
    };
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'You\'ve already poked this user — wait for them to respond');
    }
    throw err;
  }
}

/**
 * Accept a poke. Caller must be the recipient. Marks as accepted, creates
 * a corresponding encounter_history row so DMs unlock from now on, and
 * upserts the dm_conversation so they can start chatting.
 *
 * Task F1 (23 Jul 2026) — the sender previously heard nothing when their
 * poke was accepted (only a silent fanoutUserEntity badge refresh from the
 * route). A 'poke_accepted' bell notification is now inserted for the
 * sender in the same transaction as the accept, then pushed live via
 * socket ONLY after the transaction commits — mirrors sendPoke's
 * notify-then-emit pattern (L90-126) and guarantees a rolled-back accept
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
export async function acceptPoke(
  pokeId: string,
  userId: string,
): Promise<{ poke: UserPoke; conversationId: string }> {
  const FALLBACK_INTRO = "You're connected. Say hello.";

  const { poke, conversationId, senderNotif } = await transaction(async (client) => {
    const pokeResult = await client.query<{
      id: string; sender_id: string; recipient_id: string; status: string;
      message: string | null; responded_at: Date | null; created_at: Date;
    }>(
      `SELECT id, sender_id, recipient_id, status, message, responded_at, created_at
       FROM user_pokes WHERE id = $1 FOR UPDATE`,
      [pokeId],
    );
    if (pokeResult.rows.length === 0) {
      throw new NotFoundError('Poke', pokeId);
    }
    const p = pokeResult.rows[0];
    if (p.recipient_id !== userId) {
      throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Only the recipient can accept a poke');
    }
    if (p.status !== 'pending') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Poke already ${p.status}`);
    }

    // Mark accepted.
    const updated = await client.query<{ responded_at: Date }>(
      `UPDATE user_pokes SET status = 'accepted', responded_at = NOW()
       WHERE id = $1 RETURNING responded_at`,
      [pokeId],
    );

    // Seed encounter_history so canMessage() returns true from now on.
    // mutual_meet_again stays false until they actually rate each other.
    const [a, b] = normalizePair(p.sender_id, p.recipient_id);
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
    const introText = p.message && p.message.trim().length > 0
      ? p.message.trim().slice(0, 4000)
      : FALLBACK_INTRO;
    await client.query(
      `INSERT INTO direct_messages (id, conversation_id, from_user_id, content)
       VALUES ($1, $2, $3, $4)`,
      [uuid(), convResult.rows[0].id, p.sender_id, introText],
    );
    await client.query(
      `UPDATE dm_conversations SET last_message_at = NOW() WHERE id = $1`,
      [convResult.rows[0].id],
    );

    // Task F1 — bell notification for the SENDER, inserted in the same
    // transaction as the accept so it can never exist without a
    // corresponding accepted poke (and vice versa).
    const accepterResult = await client.query<{ display_name: string | null }>(
      `SELECT display_name FROM users WHERE id = $1`, [userId],
    );
    const accepterName = accepterResult.rows[0]?.display_name || 'Someone';
    const title = `${accepterName} accepted your meeting request`;
    const body = introText.slice(0, 120);
    const notifId = uuid();
    // Deliberately INSIDE this transaction, not best-effort — it's atomic
    // with the accept by design (see the Task F1 comment above this
    // function) so this can never exist without a corresponding accepted
    // poke. Do not move it to a post-commit "fire and forget" block.
    const notifResult = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (id, user_id, type, title, body, link)
       VALUES ($1, $2, 'poke_accepted', $3, $4, '/messages')
       RETURNING id, created_at`,
      [notifId, p.sender_id, title, body],
    );
    logger.info({ pokeId, accepterId: userId, conversationId: convResult.rows[0].id }, 'Poke accepted');

    return {
      poke: {
        id: p.id, senderId: p.sender_id, recipientId: p.recipient_id,
        status: 'accepted' as const, message: p.message,
        respondedAt: updated.rows[0].responded_at,
        createdAt: p.created_at,
      },
      conversationId: convResult.rows[0].id,
      senderNotif: {
        id: notifResult.rows[0].id, senderId: p.sender_id, title, body,
        createdAt: notifResult.rows[0].created_at, accepterName,
      },
    };
  });

  // Post-commit only — mirrors sendPoke's ordering so a socket push (or an
  // email) can never fire for a transaction that ended up rolled back.
  try {
    const { io } = await import('../../index');
    io.to(`user:${senderNotif.senderId}`).emit('notification:new', {
      id: senderNotif.id,
      type: 'poke_accepted',
      title: senderNotif.title,
      body: senderNotif.body,
      link: '/messages',
      isRead: false,
      createdAt: senderNotif.createdAt,
    });
    const { emitEntities } = await import('../../realtime/emit');
    const { E } = await import('../../realtime/entities');
    emitEntities(
      io, [senderNotif.senderId],
      [E.userNotifications(senderNotif.senderId), E.userInvites(senderNotif.senderId)],
    ).catch((err) => logger.warn({ err, senderId: senderNotif.senderId }, 'Poke-accepted entity fanout failed (non-fatal)'));
  } catch (err) {
    logger.warn({ err, senderId: senderNotif.senderId }, 'Poke-accepted socket push failed (non-fatal)');
  }

  // Task F2 — email the original sender, fire-and-forget, right alongside
  // the socket push above. Gated on notify_email + email_config inside the
  // helper; internally self-catching, so it can never throw here.
  void notifyPokeAcceptedByEmail(senderNotif.senderId, senderNotif.accepterName);

  return { poke, conversationId };
}

/**
 * Decline a poke. Caller must be the recipient.
 */
export async function declinePoke(pokeId: string, userId: string): Promise<UserPoke> {
  const pokeResult = await query<{
    id: string; sender_id: string; recipient_id: string; status: string;
    message: string | null; responded_at: Date | null; created_at: Date;
  }>(
    `SELECT id, sender_id, recipient_id, status, message, responded_at, created_at
     FROM user_pokes WHERE id = $1`,
    [pokeId],
  );
  if (pokeResult.rows.length === 0) throw new NotFoundError('Poke', pokeId);
  const p = pokeResult.rows[0];
  if (p.recipient_id !== userId) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Only the recipient can decline a poke');
  }
  if (p.status !== 'pending') {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Poke already ${p.status}`);
  }

  const updated = await query<{ responded_at: Date }>(
    `UPDATE user_pokes SET status = 'declined', responded_at = NOW()
     WHERE id = $1 RETURNING responded_at`,
    [pokeId],
  );

  return {
    id: p.id, senderId: p.sender_id, recipientId: p.recipient_id,
    status: 'declined', message: p.message,
    respondedAt: updated.rows[0].responded_at,
    createdAt: p.created_at,
  };
}

/**
 * List pending pokes I've received. Includes sender display info so the
 * inbox UI can render each one with avatar + name.
 */
export async function listReceivedPokes(userId: string): Promise<PokeWithSender[]> {
  const result = await query<{
    id: string; sender_id: string; recipient_id: string; status: 'pending' | 'accepted' | 'declined';
    message: string | null; responded_at: Date | null; created_at: Date;
    display_name: string | null; avatar_url: string | null;
  }>(
    `SELECT p.id, p.sender_id, p.recipient_id, p.status, p.message,
            p.responded_at, p.created_at,
            u.display_name, u.avatar_url
     FROM user_pokes p
     JOIN users u ON u.id = p.sender_id
     WHERE p.recipient_id = $1 AND p.status = 'pending'
     ORDER BY p.created_at DESC`,
    [userId],
  );
  return result.rows.map(r => ({
    id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
    status: r.status, message: r.message, respondedAt: r.responded_at,
    createdAt: r.created_at,
    senderDisplayName: r.display_name,
    senderAvatarUrl: r.avatar_url,
  }));
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
