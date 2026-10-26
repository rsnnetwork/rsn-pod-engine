// ─── Who the live join lets into an event's room (H1, 26 Oct 2026) ──────────────────────────────────────
// The one place the rule lives. session-access.ts reads who the event admits (eventRoomAdmission, one read);
// this decides what a join does with the socket, including when that read fails, and what someone the event
// does not admit is told. The resync answer (liveStateAccess) follows the same rule.

import type { Socket } from 'socket.io';
import { ErrorCodes } from '@rsn/shared';
import logger from '../../config/logger';
import { eventRoomAdmission, type EventRoomAdmission } from '../session/session-access';
import { sessionRoom } from './state/session-state';

/** A refusal production's live page shows as a toast and a banner: a code and a sentence. */
export interface EventRoomRefusal { code: string; message: string }

/** What a join does with a socket: let it into the event's room, give a removed member the terminal bounce, or refuse it. */
export type RoomEntry =
  | { kind: 'enter' }
  | { kind: 'evict' }
  | { kind: 'refuse'; refusal: EventRoomRefusal };

/** What this join's registration attempt already proved. */
export interface RegistrationOutcome {
  /** registerParticipant succeeded: the person has a participant row that is not removed. */
  registered: boolean;
  /** Its refusal code otherwise. SESSION_ALREADY_REGISTERED also proves a row that is not removed. */
  refusalCode?: string;
}

/** The words someone the event does not admit reads: the event is over, it is only for its pod's members, or try again. */
export function eventRoomRefusal(eventStatus: string, registrationCode: string | undefined): EventRoomRefusal {
  if (eventStatus === 'completed') return { code: ErrorCodes.EVENT_ENDED, message: 'This event has ended.' };
  if (eventStatus === 'cancelled') return { code: ErrorCodes.EVENT_ENDED, message: 'This event was cancelled.' };
  if (registrationCode === ErrorCodes.AUTH_FORBIDDEN) {
    return { code: ErrorCodes.AUTH_FORBIDDEN, message: 'This event is only open to its pod\'s members.' };
  }
  return { code: 'JOIN_FAILED', message: 'You could not join this event. Refresh the page to try again.' };
}

/** eventRoomAdmission, or null when the read fails (logged). */
async function readAdmission(sessionId: string, userId: string, role: string | undefined): Promise<EventRoomAdmission | null> {
  try {
    return await eventRoomAdmission(sessionId, userId, role);
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'Could not read who the event admits');
    return null;
  }
}

/**
 * What a join does with this socket. A removed row gets the terminal bounce. Someone refused only because the
 * event is full joins as before, on purpose. When the read fails, nobody who should be in is dropped (one
 * transient pool or Neon error on a reconnect or a focus return must not throw a member or the host out of a
 * running event): someone this registration proved (registered now, or already registered) and a socket the
 * event has already let into its room are let in; anyone else is asked about once more, then refused.
 */
export async function decideRoomEntry(opts: {
  socket: Socket;
  sessionId: string;
  userId: string;
  role: string | undefined;
  eventStatus: string;
  registration: RegistrationOutcome;
}): Promise<RoomEntry> {
  const { socket, sessionId, userId, role, eventStatus, registration } = opts;
  let admission = await readAdmission(sessionId, userId, role);
  if (admission === null) {
    const proven = registration.registered || registration.refusalCode === ErrorCodes.SESSION_ALREADY_REGISTERED;
    if (proven || socket.rooms.has(sessionRoom(sessionId))) return { kind: 'enter' };
    admission = await readAdmission(sessionId, userId, role);
    if (admission === null) return { kind: 'refuse', refusal: eventRoomRefusal(eventStatus, undefined) };
  }
  if (admission === 'removed') return { kind: 'evict' };
  if (admission === 'admitted') return { kind: 'enter' };
  if (registration.refusalCode === ErrorCodes.SESSION_FULL) return { kind: 'enter' };
  return { kind: 'refuse', refusal: eventRoomRefusal(eventStatus, registration.refusalCode) };
}

/** The pages told each sentence, per event (production's live page asks again on load and on every focus return). */
const toldOnThisPage = new WeakMap<Socket, Set<string>>();

/** Send the refusal unless this page was already told it for this event. A new page (a refresh) is a new socket. */
export function refuseOnce(socket: Socket, sessionId: string, refusal: EventRoomRefusal): void {
  const told = toldOnThisPage.get(socket) ?? new Set<string>();
  toldOnThisPage.set(socket, told);
  const said = `${sessionId}|${refusal.message}`;
  if (told.has(said)) return;
  told.add(said);
  socket.emit('error', refusal);
}

/**
 * Who a resync (the live roster and token rail) answers: someone the event admits, even before their join has
 * put them in the room (a resync can arrive first), or a socket the join already let in (someone over capacity).
 * A removed member is told they are removed. When the read fails, a socket in the room is answered and one
 * outside it is not.
 */
export async function liveStateAccess(
  socket: Socket,
  sessionId: string,
  userId: string,
  role: string | undefined,
): Promise<'answer' | 'removed' | 'ignore'> {
  const admission = await readAdmission(sessionId, userId, role);
  if (admission === 'removed') return 'removed';
  if (admission === 'admitted' || socket.rooms.has(sessionRoom(sessionId))) return 'answer';
  return 'ignore';
}
