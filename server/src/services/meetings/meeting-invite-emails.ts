// ─── Calendar invitations by email, once each (11 Nov 2026, Shirley Palmer's RSN 09) ─────────────────────
//
// "Meeting booked. Calendar invitation sent by email." is said only when it is true. Every invitation is written to
// meeting_invite_emails (migration 150) BEFORE it is offered to the mail provider: one row per person, meeting,
// calendar SEQUENCE and method. A second dispatch for the same meeting time finds the row and sends nothing, so a
// retried or doubled booking never emails twice; only a row that never went (failed, no provider, no address) may be
// claimed again. The row then says what happened, and screens read it as the viewer's InviteEmailState.
//
// A row left 'sending' (the server restarted between the claim and the provider's answer; a deploy restarts it) is
// treated as never sent once it is older than SENDING_STALE_MINUTES: screens say "We couldn't email the calendar
// invitation", not "emailing now" forever, and the next dispatch for that time may claim it again. The provider's own
// answer arrives within a minute (three tries, seven seconds of waiting in all), so a live send is never taken over.

import type { InviteEmailState } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';

export type InviteLogStatus = 'sending' | 'sent' | 'failed' | 'no_provider' | 'no_address';

/** How long a booking waits for its invitations to be taken by the mail provider before it answers anyway. */
export const INVITE_WAIT_MS = 6_000;

/** A 'sending' row older than this never got its answer (a restart mid-send): it reads as not sent and may be claimed. */
export const SENDING_STALE_MINUTES = 2;

/**
 * Claim this person's invitation for this meeting time, with what is about to happen (`sending`), or why it cannot go
 * (`no_provider`, `no_address`). True when this call holds the claim: no row yet, or one that never went. False when
 * the invitation was already sent or is on its way: send nothing.
 */
export async function claimInvite(meetingId: string, userId: string, sequence: number, status: 'sending' | 'no_provider' | 'no_address'): Promise<boolean> {
  const r = await query<{ id: string }>(
    `INSERT INTO meeting_invite_emails (meeting_id, user_id, sequence, method, status)
     VALUES ($1, $2, $3, 'REQUEST', $4)
     ON CONFLICT (meeting_id, user_id, sequence, method) DO UPDATE
       SET status = EXCLUDED.status, updated_at = NOW()
       WHERE meeting_invite_emails.status IN ('failed', 'no_provider', 'no_address')
          OR (meeting_invite_emails.status = 'sending'
              AND meeting_invite_emails.updated_at < NOW() - ($5::int * INTERVAL '1 minute'))
     RETURNING id`,
    [meetingId, userId, sequence, status, SENDING_STALE_MINUTES],
  );
  return r.rows.length > 0;
}

/** What the mail provider answered for an invitation this dispatch claimed. */
export async function settleInvite(meetingId: string, userId: string, sequence: number, sent: boolean): Promise<void> {
  await query(
    `UPDATE meeting_invite_emails SET status = $4, updated_at = NOW()
      WHERE meeting_id = $1 AND user_id = $2 AND sequence = $3 AND method = 'REQUEST' AND status = 'sending'`,
    [meetingId, userId, sequence, sent ? 'sent' : 'failed'],
  );
}

/** The log's status as a screen says it; a 'sending' row that never got its answer (`stale`) is not sent. */
export function inviteStateOf(status: InviteLogStatus | null | undefined, stale = false): InviteEmailState | null {
  switch (status) {
    case 'sent': return 'sent';
    case 'sending': return stale ? 'not_sent' : 'sending';
    case 'failed':
    case 'no_provider': return 'not_sent';
    case 'no_address': return 'no_address';
    default: return null;
  }
}

/**
 * The viewer's own invitation for the meeting as it stands now (its current calendar SEQUENCE): a move needs a new
 * invitation, so the old time's row no longer answers. Null when none was recorded. Never fails a read: a hiccup here
 * reads as null, and the screen then offers the calendar file without claiming anything was emailed.
 */
export async function readInviteEmail(meetingId: string | null | undefined, viewerId: string): Promise<InviteEmailState | null> {
  if (!meetingId) return null;
  try {
    const r = await query<{ status: InviteLogStatus; stale: boolean }>(
      `SELECT e.status, e.updated_at < NOW() - ($3::int * INTERVAL '1 minute') AS stale
         FROM meeting_invite_emails e
         JOIN meetings m ON m.id = e.meeting_id AND m.calendar_sequence = e.sequence
        WHERE e.meeting_id = $1 AND e.user_id = $2 AND e.method = 'REQUEST'
        LIMIT 1`,
      [meetingId, viewerId, SENDING_STALE_MINUTES],
    );
    return inviteStateOf(r.rows[0]?.status, !!r.rows[0]?.stale);
  } catch (err) {
    logger.warn({ err, meetingId }, 'invite email read failed (non-fatal)');
    return null;
  }
}

/** Wait for `work`, at most `ms`; never rejects. */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([work.catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}
