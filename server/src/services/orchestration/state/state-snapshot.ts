// ─── Versioned State Snapshot (Phase 5) ──────────────────────────────────────
// Server-pushed, monotonically-versioned snapshot of a session's participant
// state, projected from the canonical doc. Flag-gated; the client consumes it
// with a seq-guard.
//
// v2 (canonical-100%, Ship A) — per-recipient delivery with a `you` block:
//   you: { location, connState, role, token?, livekitUrl?, roomId? }
// plus the authoritative timer { endsAt }. The token for the recipient's
// CANONICAL location is minted ONLY when that location changed since the last
// emit (tracked below) or when answering a session:resync — so the regular
// co-emit cadence stays cheap. This makes the snapshot the single source a
// client needs to land in the right room with one token (the reconnect /
// dual-token race killer). Legacy match:assigned / lobby:token events still
// carry tokens during the dual-run window; Ship C retires them as carriers.

import { Server as SocketServer, Socket } from 'socket.io';
import { config } from '../../../config';
import logger from '../../../config/logger';
import { userRoom, activeSessions } from './session-state';
import { readCanonical, CanonicalSessionState, ParticipantLocation } from './canonical-state';

export interface StateSnapshotParticipant {
  userId: string;
  displayName: string;
  role: 'host' | 'cohost' | 'participant';
  connState: string;
  state: 'in_room' | 'in_main_room' | 'disconnected' | 'left';
}
export interface StateSnapshotYou {
  location: ParticipantLocation;
  connState: string;
  role: 'host' | 'cohost' | 'participant';
  /** Present only when the recipient's location changed (or on resync). */
  token?: string;
  livekitUrl?: string;
  /** The LiveKit room the token is for (lobby room when location is 'main'). */
  roomId?: string;
}
export interface StateSnapshot {
  sessionId: string;
  seq: number;
  status: string;
  currentRound: number;
  timer: { endsAt: number | null };
  participants: StateSnapshotParticipant[];
  you?: StateSnapshotYou;
}

function deriveState(connState: string, locationType: string): StateSnapshotParticipant['state'] {
  if (locationType === 'breakout') return 'in_room';
  if (connState === 'connected') return 'in_main_room';
  if (connState === 'left' || connState === 'removed' || connState === 'no_show') return 'left';
  return 'disconnected';
}

function locationKey(loc: ParticipantLocation): string {
  return loc.type === 'breakout' ? `breakout:${loc.roomId}` : 'main';
}

// sessionId → userId → last location key emitted with this module. Used to
// mint a token only when the recipient's canonical location actually moved.
// Lost on restart by design (clients already hold tokens; resync covers
// reconnects). Pruned on terminal status / missing canonical doc.
const lastEmittedLocation = new Map<string, Map<string, string>>();

export function clearSnapshotLocationCache(sessionId?: string): void {
  if (sessionId) lastEmittedLocation.delete(sessionId);
  else lastEmittedLocation.clear();
}

function baseFromDoc(doc: CanonicalSessionState): StateSnapshot {
  const names = activeSessions.get(doc.sessionId)?.displayNameCache;
  const participants: StateSnapshotParticipant[] = Object.entries(doc.participants).map(([userId, p]) => ({
    userId,
    displayName: names?.get(userId) || '',
    role: p.role,
    connState: p.connState,
    state: deriveState(p.connState, p.location.type),
  }));
  return {
    sessionId: doc.sessionId,
    seq: doc.seq,
    status: doc.status,
    currentRound: doc.currentRound,
    timer: { endsAt: doc.timer?.endsAt ?? null },
    participants,
  };
}

export async function buildStateSnapshot(sessionId: string): Promise<StateSnapshot | null> {
  const doc = await readCanonical(sessionId);
  if (!doc) return null;
  return baseFromDoc(doc);
}

/** Build the per-recipient `you` block; mint a token for the canonical
 *  location's room only when asked (location change / resync). Best-effort:
 *  a mint failure degrades to a token-less `you` (client falls back to the
 *  REST /sessions/:id/token endpoint). */
async function buildYou(
  sessionId: string,
  userId: string,
  p: CanonicalSessionState['participants'][string],
  mintToken: boolean,
): Promise<StateSnapshotYou> {
  const you: StateSnapshotYou = { location: p.location, connState: p.connState, role: p.role };
  if (!mintToken) return you;
  try {
    const sessionService = await import('../../session/session.service');
    const roomId = p.location.type === 'breakout'
      ? p.location.roomId
      : (await sessionService.getSessionById(sessionId))?.lobbyRoomId;
    if (!roomId) return you;
    const minted = await sessionService.generateLiveKitToken(sessionId, userId, roomId);
    you.token = minted.token;
    you.livekitUrl = minted.livekitUrl;
    you.roomId = roomId;
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'state-snapshot: token mint failed (client will REST-fallback)');
  }
  return you;
}

/** Flag-gated per-recipient emit: every connected participant receives the
 *  shared base + their own `you` block via their user room. (No parallel room
 *  broadcast — a same-seq broadcast would race the client seq-guard and drop
 *  the `you` payload.) */
export async function emitStateSnapshot(io: SocketServer, sessionId: string): Promise<void> {
  if (!config.snapshotEmitEnabled) return;
  try {
    const doc = await readCanonical(sessionId);
    if (!doc) { lastEmittedLocation.delete(sessionId); return; }
    const base = baseFromDoc(doc);
    let sessLocs = lastEmittedLocation.get(sessionId);
    if (!sessLocs) { sessLocs = new Map(); lastEmittedLocation.set(sessionId, sessLocs); }
    const sends = Object.entries(doc.participants)
      .filter(([, p]) => p.connState === 'connected')
      .map(async ([uid, p]) => {
        const key = locationKey(p.location);
        const prev = sessLocs!.get(uid);
        sessLocs!.set(uid, key);
        // First sighting (prev undefined) does NOT mint: on boot/first emit the
        // client already holds a working token; resync covers reconnects.
        const changed = prev !== undefined && prev !== key;
        const you = await buildYou(sessionId, uid, p, changed);
        io.to(userRoom(uid)).emit('state:snapshot', { ...base, you });
      });
    await Promise.all(sends);
    if (base.status === 'completed' || base.status === 'cancelled') {
      lastEmittedLocation.delete(sessionId);
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'emitStateSnapshot failed');
  }
}

/** Resync: reply to the requesting socket with the current snapshot including
 *  their `you` block with a freshly minted token for their canonical location
 *  — the reconnect path's single source of truth. */
export async function handleResync(_io: SocketServer, socket: Socket, data: { sessionId: string; haveSeq?: number }): Promise<void> {
  if (!config.snapshotEmitEnabled || !data?.sessionId) return;
  try {
    const doc = await readCanonical(data.sessionId);
    if (!doc) return;
    const base = baseFromDoc(doc);
    const userId: string | undefined = (socket.data as { userId?: string })?.userId;
    let p = userId ? doc.participants[userId] : undefined;
    if (userId && !p) {
      // Ship C first-join race — the joiner's presence mirror may not have
      // landed in canonical yet when their connect-time resync arrives. The
      // resync is now the ONLY lobby-token rail (lobby:token retired), so
      // going silent here left fresh joiners without lobby video. Answer
      // with a synthetic main-room `you`; generateLiveKitToken still
      // validates session membership before minting.
      p = {
        role: 'participant', connState: 'connected',
        location: { type: 'main' }, lastSeenAt: Date.now(), userSeq: doc.seq,
      } as CanonicalSessionState['participants'][string];
    }
    if (userId && p) {
      const you = await buildYou(data.sessionId, userId, p, true);
      // Record the location we answered with so the next co-emit doesn't
      // immediately re-mint for this user.
      let sessLocs = lastEmittedLocation.get(data.sessionId);
      if (!sessLocs) { sessLocs = new Map(); lastEmittedLocation.set(data.sessionId, sessLocs); }
      sessLocs.set(userId, locationKey(p.location));
      socket.emit('state:snapshot', { ...base, you });
    } else {
      socket.emit('state:snapshot', base);
    }
  } catch (err) {
    logger.warn({ err, sessionId: data?.sessionId }, 'handleResync failed');
  }
}
