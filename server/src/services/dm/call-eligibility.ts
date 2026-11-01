// ─── Who may ring whom for a video call (1 Nov 2026, 30 Oct review item 4, L12) ─────────────────────
//
// Stefan: "Users should be able to start a video call right away with a connection, without scheduling a
// meeting." So a video call needs a connection, not a held meeting:
//   - the two are connected by the one definition of a connection (connections.service.ts: an accepted meeting
//     request either way, a conversation, a 1:1 meeting both joined, or having met at an event);
//   - neither has blocked the other;
//   - both are still members (an account that is removed, suspended or banned is not rung, and cannot ring).
// No admin override: unlike messages (dm.service.ts canMessage), ringing strangers is not wanted.
// Online or not is asked when the call is rung (meeting-call.service.ts), not here: the button stays put.
// One question to the database, so the profile and the thread can ask it on every read.

import { query } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';
import { CONNECTION_SIGNALS_SQL } from '../people/connections.service';

export type CallRefusal = 'self' | 'not_found' | 'caller_inactive' | 'former_member' | 'blocked' | 'not_connected';

/** What a refused call says, in a member's words. */
export const CALL_REFUSALS: Record<CallRefusal, string> = {
  self: "You can't call yourself.",
  not_found: "We couldn't find that member.",
  caller_inactive: "Your account can't make calls right now.",
  former_member: 'This person is no longer a member of REASON, so they cannot be called.',
  blocked: 'You cannot call this member.',
  not_connected: 'You can call the people you are connected with. Send a meeting request first.',
};

export type CallEligibility = { allowed: true; name: string } | { allowed: false; reason: CallRefusal; name: string };

// $1 the caller, $2 the person rung. `connected` is the People page's own reading of the caller's connections.
// Both status checks are inline: switch to activeMemberSql after T2.
const ELIGIBILITY_SQL = `
  WITH ${CONNECTION_SIGNALS_SQL}
  SELECT (SELECT me.status FROM users me WHERE me.id = $1) AS my_status,
         t.status AS their_status,
         t.display_name AS their_name,
         EXISTS (SELECT 1 FROM user_blocks b
                  WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) AS blocked,
         EXISTS (SELECT 1 FROM people WHERE person_id = $2) AS connected
    FROM users t
   WHERE t.id = $2`;

interface Row {
  my_status: string | null;
  their_status: string;
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
  if (r.my_status !== 'active') return { allowed: false, reason: 'caller_inactive', name };
  if (r.their_status !== 'active') return { allowed: false, reason: 'former_member', name };
  if (!r.connected) return { allowed: false, reason: 'not_connected', name };
  return { allowed: true, name };
}

/** The profile's and the thread's `canCall`. */
export async function canVideoCall(callerId: string, calleeId: string): Promise<boolean> {
  return (await callEligibility(callerId, calleeId)).allowed;
}

/** The caller may ring this person, or the refusal in a sentence: 400 yourself, 404 no such member, 403 the rest. */
export async function requireConnection(callerId: string, calleeId: string): Promise<{ name: string }> {
  const answer = await callEligibility(callerId, calleeId);
  if (answer.allowed) return { name: answer.name };
  const message = CALL_REFUSALS[answer.reason];
  if (answer.reason === 'self') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, message);
  if (answer.reason === 'not_found') throw new NotFoundError('User', calleeId, message);
  throw new ForbiddenError(message);
}
