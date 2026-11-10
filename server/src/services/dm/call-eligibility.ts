// ─── Who may ring whom for a call (1 Nov 2026, 30 Oct review item 4, L12) ───────────────────────────
//
// Stefan: "Users should be able to start a video call right away with a connection, without scheduling a
// meeting." So a video call needs a real mutual connection, not a held meeting (L12: connections only, no admin
// override):
//   - the two are mutually connected (MUTUAL_CONNECTION_SQL): a meeting request one of them accepted, both saying
//     "meet again", or a 1:1 meeting the two held. A conversation on its own does not count (fix round 1): an
//     admin may message anyone and a host's broadcast opens a thread with every participant, so a thread proves
//     nothing either person chose;
//   - neither has blocked the other;
//   - both are still members (an account that is removed, suspended or banned is not rung, and cannot ring).
// Audio keeps the 9 Sep rule (calls unlocked, meeting-call.service.ts), so for it only the block and the two
// accounts are asked (requireMembers).
// Online or not is asked when the call is rung (meeting-call.service.ts), not here: the button stays put.
// One question to the database, about this pair only, so the profile and the thread can ask it on every read.

import { query } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { activeMemberSql } from '../users/active-member';

export type CallRefusal =
  'self' | 'not_found' | 'caller_inactive' | 'former_member' | 'event_guest' | 'blocked' | 'not_connected';

/** What a refused call says, in a member's words. */
export const CALL_REFUSALS: Record<CallRefusal, string> = {
  self: "You can't call yourself.",
  not_found: "We couldn't find that member.",
  caller_inactive: "Your account can't make calls right now.",
  former_member: 'This person is no longer a member of REASON, so they cannot be called.',
  event_guest: 'Calls are for members. This person came to an event as a guest and is not a member yet.',
  blocked: 'You cannot call this member.',
  not_connected: 'You can call the people you are connected with. Send a meeting request first.',
};

export type CallEligibility = { allowed: true; name: string } | { allowed: false; reason: CallRefusal; name: string };

/**
 * $1 and $2 are a real mutual connection: a meeting request one accepted, both saying "meet again", or a 1:1 meeting
 * they held (both joined, or calls unlocked by it). Never a conversation on its own, and never only having been at
 * the same event. The one reading of "connected" for calls: every call route and both canCall fields use it.
 */
export const MUTUAL_CONNECTION_SQL = `
  EXISTS (SELECT 1 FROM user_pokes p
           WHERE p.status = 'accepted'
             AND ((p.sender_id = $1 AND p.recipient_id = $2) OR (p.sender_id = $2 AND p.recipient_id = $1)))
  OR EXISTS (SELECT 1 FROM encounter_history e
              WHERE e.user_a_id = LEAST($1::uuid, $2::uuid) AND e.user_b_id = GREATEST($1::uuid, $2::uuid)
                AND e.mutual_meet_again)
  OR EXISTS (SELECT 1 FROM dm_conversations c
              WHERE c.user_a_id = LEAST($1::uuid, $2::uuid) AND c.user_b_id = GREATEST($1::uuid, $2::uuid)
                AND (c.calls_unlocked_at IS NOT NULL OR (c.meeting_joined_a_at IS NOT NULL AND c.meeting_joined_b_at IS NOT NULL)))`;

// $1 the caller, $2 the person rung.
const ELIGIBILITY_SQL = `
  SELECT (SELECT ${activeMemberSql('me')} AS me_active FROM users me WHERE me.id = $1) AS my_active,
         ${activeMemberSql('t')} AS they_active,
         ((SELECT me.account_kind FROM users me WHERE me.id = $1) = 'event_guest' OR t.account_kind = 'event_guest') AS a_guest,
         t.display_name AS their_name,
         EXISTS (SELECT 1 FROM user_blocks b
                  WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked,
         (${MUTUAL_CONNECTION_SQL}) AS connected
    FROM users t
   WHERE t.id = $2`;

interface Row {
  my_active: boolean | null;
  they_active: boolean;
  /** Either of the two is an event guest (Part 2, Task 3): calls are for members. */
  a_guest?: boolean | null;
  their_name: string | null;
  blocked: boolean;
  connected: boolean;
}

/** The name a call sentence uses for the person rung. */
const nameOf = (r: Row | undefined): string => r?.their_name?.trim() || 'This member';

export async function callEligibility(callerId: string, calleeId: string): Promise<CallEligibility> {
  if (callerId === calleeId) return { allowed: false, reason: 'self', name: '' };
  const r = (await query<Row>(ELIGIBILITY_SQL, [callerId, calleeId])).rows[0];
  if (!r) return { allowed: false, reason: 'not_found', name: '' };
  const name = nameOf(r);
  // A block answers first, so a blocked person learns nothing else about the other.
  if (r.blocked) return { allowed: false, reason: 'blocked', name };
  if (!r.my_active) return { allowed: false, reason: 'caller_inactive', name };
  if (!r.they_active) return { allowed: false, reason: 'former_member', name };
  if (r.a_guest) return { allowed: false, reason: 'event_guest', name };
  if (!r.connected) return { allowed: false, reason: 'not_connected', name };
  return { allowed: true, name };
}

/** The profile's and the thread's `canCall`: exactly what the call routes allow for video. */
export async function canVideoCall(callerId: string, calleeId: string): Promise<boolean> {
  return (await callEligibility(callerId, calleeId)).allowed;
}

function refuse(answer: Extract<CallEligibility, { allowed: false }>, calleeId: string): never {
  const message = CALL_REFUSALS[answer.reason];
  if (answer.reason === 'self') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, message);
  if (answer.reason === 'not_found') throw new NotFoundError('User', calleeId, message);
  throw new ForbiddenError(message);
}

/** Video: the caller may ring this person, or the refusal in a sentence (400 yourself, 404 no such member, 403 the rest). */
export async function requireConnection(callerId: string, calleeId: string): Promise<{ name: string }> {
  const answer = await callEligibility(callerId, calleeId);
  if (answer.allowed) return { name: answer.name };
  return refuse(answer, calleeId);
}

/** Audio, whose own rule is calls unlocked: only no block and both still members are asked here. */
export async function requireMembers(callerId: string, calleeId: string): Promise<{ name: string }> {
  const answer = await callEligibility(callerId, calleeId);
  if (answer.allowed || answer.reason === 'not_connected') return { name: answer.name };
  return refuse(answer, calleeId);
}
