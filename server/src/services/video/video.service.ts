// ─── Video Service ───────────────────────────────────────────────────────────
// Facade over the IVideoProvider. Provides session-aware room management
// and token generation. Orchestration service calls this, never the provider
// directly.

import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';
import { IVideoProvider } from './video.interface';
import { LiveKitProvider } from './livekit.provider';
import { MockVideoProvider } from './mock.provider';
import { config } from '../../config';
import logger from '../../config/logger';

// ─── Provider Singleton ─────────────────────────────────────────────────────

let provider: IVideoProvider;

export function getVideoProvider(): IVideoProvider {
  if (!provider) {
    if (config.livekit.apiKey && config.livekit.apiSecret) {
      provider = new LiveKitProvider();
      logger.info('Video provider initialised: LiveKit');
    } else {
      provider = new MockVideoProvider();
      logger.info('Video provider initialised: Mock (no LiveKit credentials)');
    }
  }
  return provider;
}

/** Allow injecting a mock/test provider. */
export function setVideoProvider(p: IVideoProvider): void {
  provider = p;
}

// ─── Room Naming ────────────────────────────────────────────────────────────

export function lobbyRoomId(sessionId: string): string {
  return `lobby-${sessionId}`;
}

export function matchRoomId(sessionId: string, roundNumber: number, matchIdShort: string): string {
  return `match-${sessionId}-r${roundNumber}-${matchIdShort}`;
}

// ─── Session Room Lifecycle ─────────────────────────────────────────────────

export async function createLobbyRoom(
  sessionId: string,
  emptyTimeoutSeconds: number = 3600
): Promise<VideoRoom> {
  const p = getVideoProvider();
  const roomId = lobbyRoomId(sessionId);
  return p.createRoom(roomId, RoomType.LOBBY, sessionId, emptyTimeoutSeconds);
}

export async function createMatchRoom(
  sessionId: string,
  roundNumber: number,
  matchIdShort: string,
  emptyTimeoutSeconds: number = 300
): Promise<VideoRoom> {
  const p = getVideoProvider();
  const roomId = matchRoomId(sessionId, roundNumber, matchIdShort);
  return p.createRoom(roomId, RoomType.ONE_TO_ONE, sessionId, emptyTimeoutSeconds);
}

export async function closeLobbyRoom(sessionId: string): Promise<void> {
  const p = getVideoProvider();
  await p.closeRoom(lobbyRoomId(sessionId));
}

export async function closeMatchRoom(
  sessionId: string,
  roundNumber: number,
  matchIdShort: string
): Promise<void> {
  const p = getVideoProvider();
  await p.closeRoom(matchRoomId(sessionId, roundNumber, matchIdShort));
}

// ─── Token Generation ───────────────────────────────────────────────────────

export async function issueJoinToken(
  userId: string,
  roomId: string,
  displayName: string,
  tokenTtl?: number
): Promise<VideoToken> {
  const p = getVideoProvider();
  return p.issueJoinToken(userId, roomId, displayName, tokenTtl);
}

// ─── Participant Operations ─────────────────────────────────────────────────

export async function moveParticipant(
  userId: string,
  fromRoomId: string,
  toRoomId: string
): Promise<void> {
  const p = getVideoProvider();
  return p.moveParticipant(userId, fromRoomId, toRoomId);
}

export async function listParticipants(roomId: string): Promise<VideoParticipant[]> {
  const p = getVideoProvider();
  return p.listParticipants(roomId);
}

export async function roomExists(roomId: string): Promise<boolean> {
  const p = getVideoProvider();
  return p.roomExists(roomId);
}

/** Best-effort eviction of a participant from a LiveKit room (Phase 4, G1).
 *  Never throws — a participant who already left the room is the common case. */
export async function evictFromRoom(userId: string, roomId: string): Promise<void> {
  try {
    await getVideoProvider().removeParticipant(roomId, userId);
  } catch (err) {
    logger.warn({ err, userId, roomId }, 'evictFromRoom failed (non-fatal)');
  }
}

/**
 * Phase U — LiveKit-level mute enforcement.
 * Sets a participant's publish permission live on the SFU. Called from
 * host-actions after persisting host_muted to session_participants so
 * the LiveKit layer matches the DB state. Idempotent and safe to call
 * even if the participant is not currently in the room (provider
 * swallows NotFound).
 */
export async function setParticipantCanPublishAudio(
  roomId: string,
  userId: string,
  canPublishAudio: boolean,
): Promise<void> {
  const p = getVideoProvider();
  return p.setParticipantCanPublishAudio(roomId, userId, canPublishAudio);
}
