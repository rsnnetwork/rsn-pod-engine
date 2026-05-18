// ─── Realtime fanout helper (server-side) ────────────────────────────────────
//
// Single fanout entry point for the new entity-tag pattern. Replaces the
// bespoke notifyPodChanged / notifySessionListChanged / etc. fanouts over
// the course of the migration (see
// docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md).
//
// Contract:
// - `userIds` are the recipients whose user-rooms get the broadcast.
// - `entities` is a list of domain-entity strings (built via E from ./entities)
//   identifying what just changed. The client's useEntityChangedHandler
//   matches incoming entities against each query's meta.entities and
//   invalidates the matches.
//
// Phase 1 (this commit): helper exists, is exported, has tests pinning
// the shape. Nothing in the codebase calls it yet — that's Phase 2's job
// (dual-emit alongside the existing bespoke fanouts).

import type { Server as SocketServer } from 'socket.io';
import logger from '../config/logger';
import { userRoom } from '../services/orchestration/state/session-state';

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
