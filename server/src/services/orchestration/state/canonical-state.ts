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

/**
 * Ship B — the fail-open flip helper for presence-membership reads.
 * Returns the set of userIds whose canonical connState is 'connected', or
 * NULL when the doc is missing/empty (Redis down, session pre-dates the
 * canonical projection, or nothing projected yet). Callers treat null as
 * "canonical unavailable" and fall back to the legacy presenceMap — never
 * an empty set, which would wrongly read as "nobody is here".
 */
export async function getCanonicalConnectedSet(sessionId: string): Promise<Set<string> | null> {
  const doc = await readCanonical(sessionId);
  if (!doc || Object.keys(doc.participants).length === 0) return null;
  const connected = new Set<string>();
  for (const [uid, p] of Object.entries(doc.participants)) {
    if (p.connState === 'connected') connected.add(uid);
  }
  return connected;
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
 * Lost-update guard (4 Jun, found by the Ship B headed smoke) — every mutator
 * below is a read-modify-write of the WHOLE doc. Two concurrent RMWs both
 * read the same base doc and the later write erased the earlier one. In prod
 * the writers are genuinely concurrent (fire-and-forget heartbeat mirrors,
 * setRoomAssignment placements, webhook/sweep heals, resync paths) — observed
 * as a heartbeat mirror clobbering a just-written breakout location, which
 * mis-routed room chat to the sender only. Serialize all canonical RMWs per
 * session through a promise chain. Correct for the current single-instance
 * deployment; the multi-instance scale-out needs WATCH/Lua here instead.
 */
const _rmwChains = new Map<string, Promise<void>>();
function serializeRmw(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = _rmwChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.catch(() => {});
  _rmwChains.set(sessionId, tracked);
  void tracked.then(() => {
    if (_rmwChains.get(sessionId) === tracked) _rmwChains.delete(sessionId);
  });
  return next;
}

/**
 * Patch a single participant in the canonical doc and bump seq. Read-modify-
 * write of the one key, serialized per session (see serializeRmw above).
 * Best-effort: no-op if Redis down or the doc doesn't exist yet (the periodic
 * shadow projection backfills it).
 */
export function updateCanonicalParticipant(
  sessionId: string,
  userId: string,
  patch: Partial<CanonicalParticipant>,
): Promise<void> {
  return serializeRmw(sessionId, async () => {
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
  });
}

/**
 * Ship A regression fix (4 Jun live test) — room EXIT must reset canonical
 * location. Room ENTRY writes canonical directly (setRoomAssignment); the
 * state-machine "return to main" transitions early-return on their idempotent
 * path (the in-memory map never goes IN_BREAKOUT), so they never reset
 * location — and the snapshot/resync wire then walked participants BACK into
 * the dead room ~10-30s after round end. These helpers are the symmetric
 * direct write for room exit. The matchId guard makes the batch clear
 * race-safe: a user already re-placed into a NEWER room (different matchId)
 * is never stomped.
 */
export function clearCanonicalBreakoutByMatch(
  sessionId: string,
  matchIds: string[] | Set<string>,
): Promise<void> {
  const ids = matchIds instanceof Set ? matchIds : new Set(matchIds);
  if (ids.size === 0) return Promise.resolve();
  return serializeRmw(sessionId, async () => {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      const doc = await readCanonical(sessionId);
      if (!doc) return;
      let changed = false;
      for (const p of Object.values(doc.participants)) {
        if (p.location.type === 'breakout' && ids.has(p.location.matchId)) {
          p.location = { type: 'main' };
          p.userSeq = doc.seq + 1;
          changed = true;
        }
      }
      if (!changed) return;
      doc.seq += 1;
      await redis.setex(canonicalKey(sessionId), CANONICAL_TTL, JSON.stringify(doc));
    } catch (err) {
      logger.warn({ err, sessionId }, 'clearCanonicalBreakoutByMatch failed');
    }
  });
}

/** Explicit single-user return-to-main (voluntary leave / host pull-back). */
export async function clearCanonicalLocationToMain(sessionId: string, userId: string): Promise<void> {
  await updateCanonicalParticipant(sessionId, userId, { location: { type: 'main' } });
}

/**
 * Serialized MERGE for the shadow projection (4 Jun ghost root cause).
 * Pre-fix the shadow OVERWROTE the whole doc from in-memory state on every
 * persistSessionState — and its location source (roomParticipants) is never
 * cleaned at round end, so it kept resurrecting dead breakout locations
 * after the room-end clears. Canonical participants are AUTHORITATIVE now:
 * existing entries are preserved verbatim; the projection only contributes
 * brand-new participants and the doc-level fields (status/round/timer).
 */
export function mergeProjectedCanonical(projected: CanonicalSessionState): Promise<void> {
  return serializeRmw(projected.sessionId, async () => {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      const prev = await readCanonical(projected.sessionId);
      if (!prev) {
        await redis.setex(canonicalKey(projected.sessionId), CANONICAL_TTL, JSON.stringify(projected));
        return;
      }
      const merged: CanonicalSessionState = {
        ...projected,
        seq: prev.seq + 1,
        participants: { ...projected.participants, ...prev.participants },
      };
      await redis.setex(canonicalKey(projected.sessionId), CANONICAL_TTL, JSON.stringify(merged));
    } catch (err) {
      logger.warn({ err, sessionId: projected.sessionId }, 'mergeProjectedCanonical failed');
    }
  });
}

/** Set the canonical session status and bump seq. Same guard/best-effort rules. */
export function updateCanonicalSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  return serializeRmw(sessionId, async () => {
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
  });
}
