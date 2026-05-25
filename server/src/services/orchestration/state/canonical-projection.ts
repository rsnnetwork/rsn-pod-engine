// server/src/services/orchestration/state/canonical-projection.ts
// ─── Canonical Projection ────────────────────────────────────────────────────
// Canonical-room-state Phase 1 (shadow). Derives the orthogonal location +
// connState model from today's four stores so the canonical doc is populated
// and can be validated against reality before any read path is switched.

import type { ActiveSession } from './session-state';
import type {
  CanonicalSessionState,
  CanonicalParticipant,
  ParticipantLocation,
  ConnState,
} from './canonical-state';

function connStateFor(
  uid: string,
  presenceMap: ActiveSession['presenceMap'],
  participantStates: ActiveSession['participantStates'],
): ConnState {
  if (presenceMap.has(uid)) return 'connected';
  const dbState = participantStates?.get(uid)?.state;
  switch (dbState) {
    case 'left':     return 'left';
    case 'removed':  return 'removed';
    case 'no_show':  return 'no_show';
    default:         return 'disconnected';
  }
}

function locationFor(
  uid: string,
  roomParticipants: ActiveSession['roomParticipants'],
): ParticipantLocation {
  const room = roomParticipants?.get(uid);
  if (room) return { type: 'breakout', roomId: room.roomId, matchId: room.matchId };
  return { type: 'main' };
}

/** Project the live ActiveSession into a canonical document. Pure function. */
export function projectActiveSessionToCanonical(
  s: ActiveSession,
  prevSeq: number,
): CanonicalSessionState {
  const ids = new Set<string>();
  s.participantStates?.forEach((_v, k) => ids.add(k));
  s.presenceMap.forEach((_v, k) => ids.add(k));
  s.roomParticipants?.forEach((_v, k) => ids.add(k));
  ids.add(s.hostUserId);

  const participants: Record<string, CanonicalParticipant> = {};
  for (const uid of ids) {
    participants[uid] = {
      role: uid === s.hostUserId ? 'host' : 'participant',
      connState: connStateFor(uid, s.presenceMap, s.participantStates),
      location: locationFor(uid, s.roomParticipants),
      lastSeenAt: s.presenceMap.get(uid)?.lastHeartbeat.getTime() ?? 0,
      userSeq: prevSeq + 1,
    };
  }

  return {
    sessionId: s.sessionId,
    status: s.status,
    currentRound: s.currentRound,
    seq: prevSeq + 1,
    hostUserId: s.hostUserId,
    timer: s.timerEndsAt ? { kind: s.status, endsAt: s.timerEndsAt.getTime() } : null,
    participants,
  };
}
