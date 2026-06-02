// ─── Versioned State Snapshot (Phase 5) ──────────────────────────────────────
// Server-pushed, monotonically-versioned snapshot of a session's participant
// state, projected from the canonical doc. Additive + flag-gated; the client
// consumes it with a seq-guard. Does NOT carry video tokens (no token-folding).

import { Server as SocketServer, Socket } from 'socket.io';
import { config } from '../../../config';
import logger from '../../../config/logger';
import { sessionRoom, activeSessions } from './session-state';
import { readCanonical } from './canonical-state';

export interface StateSnapshotParticipant {
  userId: string;
  displayName: string;
  role: 'host' | 'cohost' | 'participant';
  connState: string;
  state: 'in_room' | 'in_main_room' | 'disconnected' | 'left';
}
export interface StateSnapshot {
  sessionId: string;
  seq: number;
  status: string;
  currentRound: number;
  participants: StateSnapshotParticipant[];
}

function deriveState(connState: string, locationType: string): StateSnapshotParticipant['state'] {
  if (locationType === 'breakout') return 'in_room';
  if (connState === 'connected') return 'in_main_room';
  if (connState === 'left' || connState === 'removed' || connState === 'no_show') return 'left';
  return 'disconnected';
}

export async function buildStateSnapshot(sessionId: string): Promise<StateSnapshot | null> {
  const doc = await readCanonical(sessionId);
  if (!doc) return null;
  const names = activeSessions.get(sessionId)?.displayNameCache;
  const participants: StateSnapshotParticipant[] = Object.entries(doc.participants).map(([userId, p]) => ({
    userId,
    displayName: names?.get(userId) || '',
    role: p.role,
    connState: p.connState,
    state: deriveState(p.connState, p.location.type),
  }));
  return { sessionId, seq: doc.seq, status: doc.status, currentRound: doc.currentRound, participants };
}

/** Flag-gated broadcast to the whole session room. No-op when disabled. */
export async function emitStateSnapshot(io: SocketServer, sessionId: string): Promise<void> {
  if (!config.snapshotEmitEnabled) return;
  try {
    const snap = await buildStateSnapshot(sessionId);
    if (snap) io.to(sessionRoom(sessionId)).emit('state:snapshot', snap);
  } catch (err) {
    logger.warn({ err, sessionId }, 'emitStateSnapshot failed');
  }
}

/** Resync: reply to the requesting socket with the current snapshot. */
export async function handleResync(_io: SocketServer, socket: Socket, data: { sessionId: string }): Promise<void> {
  if (!config.snapshotEmitEnabled || !data?.sessionId) return;
  try {
    const snap = await buildStateSnapshot(data.sessionId);
    if (snap) socket.emit('state:snapshot', snap);
  } catch (err) {
    logger.warn({ err, sessionId: data?.sessionId }, 'handleResync failed');
  }
}
