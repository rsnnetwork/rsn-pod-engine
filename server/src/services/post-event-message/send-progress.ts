// ─── Telling the people who run an event that a send moved on ─────────────────
//
// A "message everyone" send takes minutes for a big event, and the people who run it watch a sentence
// that says how far it is ("Sending… 12 of 40."). They are told through the event's own entity tag,
// session:<id>, which the screens that show that sentence declare, so they refetch instead of polling.
// Used by the worker (after each batch and at the end) and by the route (when a send starts).
// Telling is best-effort: a lookup or an emit that fails is logged and never fails the send.

import type { Server as SocketServer } from 'socket.io';
import logger from '../../config/logger';
import { emitEntities } from '../../realtime/emit';
import { E } from '../../realtime/entities';
import { resolveEventOrganiserIds } from './event-organisers';

/** The sender, and everyone else who runs the event (they may be looking at the same panel). */
export async function resolveProgressAudience(sessionId: string, senderId: string): Promise<string[]> {
  try {
    return [...new Set([senderId, ...(await resolveEventOrganiserIds(sessionId))])];
  } catch (err) {
    logger.warn({ err, sessionId }, 'Post-event message: could not look up the organisers to tell; telling the sender only');
    return [senderId];
  }
}

export async function reportProgress(io: SocketServer | null, audience: string[], sessionId: string): Promise<void> {
  try {
    await emitEntities(io, audience, [E.session(sessionId)]);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Post-event message: progress notification failed (non-fatal)');
  }
}
