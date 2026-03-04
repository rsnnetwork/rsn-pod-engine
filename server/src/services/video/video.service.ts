// ─── Video Service ───────────────────────────────────────────────────────────
// Facade over the IVideoProvider. Provides session-aware room management
// and token generation. Orchestration service calls this, never the provider
// directly.

import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';
import { IVideoProvider } from './video.interface';
import { LiveKitProvider } from './livekit.provider';
import logger from '../../config/logger';

// ─── Provider Singleton ─────────────────────────────────────────────────────

let provider: IVideoProvider;

export function getVideoProvider(): IVideoProvider {
  if (!provider) {
    provider = new LiveKitProvider();
    logger.info('Video provider initialised: LiveKit');
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

export async function createLobbyRoom(sessionId: string): Promise<VideoRoom> {
  const p = getVideoProvider();
  const roomId = lobbyRoomId(sessionId);
  return p.createRoom(roomId, RoomType.LOBBY, sessionId);
}

export async function createMatchRoom(
  sessionId: string,
  roundNumber: number,
  matchIdShort: string
): Promise<VideoRoom> {
  const p = getVideoProvider();
  const roomId = matchRoomId(sessionId, roundNumber, matchIdShort);
  return p.createRoom(roomId, RoomType.ONE_TO_ONE, sessionId);
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
  displayName: string
): Promise<VideoToken> {
  const p = getVideoProvider();
  return p.issueJoinToken(userId, roomId, displayName);
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
