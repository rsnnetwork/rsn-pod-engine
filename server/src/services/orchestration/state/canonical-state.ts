// server/src/services/orchestration/state/canonical-state.ts
// ─── Canonical Session State ─────────────────────────────────────────────────
// Canonical-room-state Phase 1. ONE authoritative document per session, in
// Redis. `location` is single-valued so dual-room is unrepresentable; `seq` is
// a monotonic version so clients can discard stale snapshots. Phase 1 only
// WRITES this doc (shadow); reads stay on the existing code until Phase 3.
//
// Namespace note: the existing write-through blob lives at `rsn:session:{id}`
// and restoreAllFromRedis globs `rsn:session:*`. This doc MUST use a separate
// namespace (`rsn:canonical:`) or that glob would mis-parse it.

import { SessionStatus } from '@rsn/shared';
import logger from '../../../config/logger';
import { getRedisClient } from '../../redis/redis.client';

export type ParticipantLocation =
  | { type: 'main' }
  | { type: 'breakout'; roomId: string; matchId: string };

export type ConnState = 'connected' | 'disconnected' | 'left' | 'removed' | 'no_show';

export interface CanonicalParticipant {
  role: 'host' | 'cohost' | 'participant';
  connState: ConnState;
  location: ParticipantLocation;
  lastSeenAt: number; // epoch ms
  userSeq: number;
}

export interface CanonicalSessionState {
  sessionId: string;
  status: SessionStatus;
  currentRound: number;
  seq: number; // monotonic; bumped on every mutation
  hostUserId: string;
  timer: { kind: string; endsAt: number } | null;
  participants: Record<string, CanonicalParticipant>;
}

const CANONICAL_PREFIX = 'rsn:canonical:';
const CANONICAL_TTL = 14400; // 4h — matches existing session TTL

export function canonicalKey(sessionId: string): string {
  return `${CANONICAL_PREFIX}${sessionId}`;
}

/** Read the canonical doc. Returns null if Redis is unavailable or key absent. */
export async function readCanonical(sessionId: string): Promise<CanonicalSessionState | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(canonicalKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as CanonicalSessionState;
  } catch (err) {
    logger.warn({ err, sessionId }, 'readCanonical failed');
    return null;
  }
}

/** Write the canonical doc with TTL. No-op when Redis is unavailable. */
export async function writeCanonical(state: CanonicalSessionState): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.setex(canonicalKey(state.sessionId), CANONICAL_TTL, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err, sessionId: state.sessionId }, 'writeCanonical failed');
  }
}

/**
 * Patch a single participant in the canonical doc and bump seq. Read-modify-
 * write of the one key; callers MUST hold withSessionGuard for the session
 * (the transition chokepoint does). Best-effort: no-op if Redis down or the
 * doc doesn't exist yet (the periodic shadow projection backfills it).
 */
export async function updateCanonicalParticipant(
  sessionId: string,
  userId: string,
  patch: Partial<CanonicalParticipant>,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const doc = await readCanonical(sessionId);
    if (!doc) return;
    const prev = doc.participants[userId] ?? {
      role: 'participant', connState: 'disconnected',
      location: { type: 'main' }, lastSeenAt: 0, userSeq: doc.seq,
    } as CanonicalParticipant;
    doc.participants[userId] = { ...prev, ...patch, userSeq: doc.seq + 1 };
    doc.seq += 1;
    await redis.setex(canonicalKey(sessionId), CANONICAL_TTL, JSON.stringify(doc));
  } catch (err) {
    logger.warn({ err, sessionId, userId }, 'updateCanonicalParticipant failed');
  }
}

/** Set the canonical session status and bump seq. Same guard/best-effort rules. */
export async function updateCanonicalSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const doc = await readCanonical(sessionId);
    if (!doc) return;
    doc.status = status;
    doc.seq += 1;
    await redis.setex(canonicalKey(sessionId), CANONICAL_TTL, JSON.stringify(doc));
  } catch (err) {
    logger.warn({ err, sessionId, status }, 'updateCanonicalSessionStatus failed');
  }
}
