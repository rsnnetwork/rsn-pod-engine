// ─── Realtime fanout helper (server-side) ────────────────────────────────────
//
// Single fanout entry point for the entity-tag pattern. After Phase 5 of the
// realtime architecture migration this is the ONLY way the server signals
// state changes to clients. The legacy bespoke events (pod:membership_updated,
// session:list_changed, admin:list_changed, notification:list_changed,
// user:blocks_changed, user:changed, group:changed) and their wrapper
// helpers (notifyPodChanged / notifySessionListChanged / etc.) have been
// deleted. The two events that survive — permissions:updated and
// roster:changed — are load-bearing for Zustand hydration in
// useSessionSocket and live in the dedicated emitPermissionsUpdated helper
// in `./fanout.ts`.
//
// See: docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
//
// Contract for emitEntities:
// - `userIds` are the recipients whose user-rooms get the broadcast.
// - `entities` is a list of domain-entity strings (built via E from ./entities)
//   identifying what just changed. The client's useEntityChangedHandler
//   matches incoming entities against each query's meta.entities and
//   invalidates the matches.

import type { Server as SocketServer } from 'socket.io';
import logger from '../config/logger';
import { userRoom } from '../services/orchestration/state/session-state';

// ─── Cached io reference ────────────────────────────────────────────────────
//
// Set once during orchestration init so the fanout helpers below (which run
// from REST routes that don't carry an `io` parameter) can emit without the
// caller threading it through.

let cachedIo: SocketServer | null = null;

export function setRealtimeIo(io: SocketServer): void {
  cachedIo = io;
}

export function getRealtimeIo(): SocketServer | null {
  return cachedIo;
}

// ─── Core entity fanout ─────────────────────────────────────────────────────

export async function emitEntities(
  io: SocketServer | null,
  userIds: string[] | Iterable<string>,
  entities: string[],
): Promise<void> {
  if (!io) return;
  if (entities.length === 0) return;

  const recipients = new Set<string>();
  for (const id of userIds) {
    if (id) recipients.add(id);
  }
  if (recipients.size === 0) return;

  try {
    for (const userId of recipients) {
      io.to(userRoom(userId)).emit('entity:changed', { entities });
    }
  } catch (err) {
    logger.warn({ err, recipientCount: recipients.size, entities }, 'emitEntities fanout failed (non-fatal)');
  }
}
