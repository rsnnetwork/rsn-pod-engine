// ─── Mock Video Provider ─────────────────────────────────────────────────────
// In-memory implementation for local development without LiveKit.

import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';
import { IVideoProvider } from './video.interface';
import logger from '../../config/logger';

const rooms = new Map<string, { room: VideoRoom; participants: VideoParticipant[] }>();

export class MockVideoProvider implements IVideoProvider {
  async createRoom(roomId: string, type: RoomType, sessionId: string): Promise<VideoRoom> {
    const room: VideoRoom = { roomId, type, sessionId, participantCount: 0, createdAt: new Date() };
    rooms.set(roomId, { room, participants: [] });
    logger.debug({ roomId, type }, 'MockVideo: room created');
    return room;
  }

  async closeRoom(roomId: string): Promise<void> {
    rooms.delete(roomId);
    logger.debug({ roomId }, 'MockVideo: room closed');
  }

  async issueJoinToken(userId: string, roomId: string, _displayName: string): Promise<VideoToken> {
    return { token: `mock-token-${userId}-${roomId}`, roomId, userId, expiresAt: new Date(Date.now() + 3600_000) };
  }

  async moveParticipant(userId: string, fromRoomId: string, toRoomId: string): Promise<void> {
    const from = rooms.get(fromRoomId);
    if (from) from.participants = from.participants.filter(p => p.userId !== userId);
    const to = rooms.get(toRoomId);
    if (to) to.participants.push({ userId, roomId: toRoomId, joinedAt: new Date(), isConnected: true });
    logger.debug({ userId, fromRoomId, toRoomId }, 'MockVideo: participant moved');
  }

  async listParticipants(roomId: string): Promise<VideoParticipant[]> {
    return rooms.get(roomId)?.participants || [];
  }

  async roomExists(roomId: string): Promise<boolean> {
    return rooms.has(roomId);
  }
}
