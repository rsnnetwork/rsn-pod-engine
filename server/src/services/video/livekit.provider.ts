// ─── LiveKit Video Provider ──────────────────────────────────────────────────
// Concrete implementation of IVideoProvider backed by LiveKit.
// Uses the livekit-server-sdk for room management and token generation.

import {
  RoomServiceClient,
  AccessToken,
  VideoGrant,
} from 'livekit-server-sdk';
import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';
import { IVideoProvider } from './video.interface';
import config from '../../config';
import logger from '../../config/logger';

export class LiveKitProvider implements IVideoProvider {
  private roomService: RoomServiceClient;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.apiKey = config.livekit.apiKey;
    this.apiSecret = config.livekit.apiSecret;
    this.roomService = new RoomServiceClient(
      config.livekit.host,
      this.apiKey,
      this.apiSecret
    );
  }

  // ─── Create Room ────────────────────────────────────────────────────────

  async createRoom(roomId: string, type: RoomType, sessionId: string): Promise<VideoRoom> {
    try {
      const maxParticipants = type === RoomType.LOBBY ? 500
        : type === RoomType.ONE_TO_ONE ? 2
        : 10;

      const emptyTimeout = type === RoomType.ONE_TO_ONE ? 300 : 3600; // seconds

      await this.roomService.createRoom({
        name: roomId,
        emptyTimeout,
        maxParticipants,
        metadata: JSON.stringify({ type, sessionId }),
      });

      logger.info({ roomId, type, sessionId }, 'LiveKit room created');

      return {
        roomId,
        type,
        sessionId,
        participantCount: 0,
        createdAt: new Date(),
      };
    } catch (err) {
      logger.error({ err, roomId }, 'Failed to create LiveKit room');
      throw err;
    }
  }

  // ─── Close Room ─────────────────────────────────────────────────────────

  async closeRoom(roomId: string): Promise<void> {
    try {
      await this.roomService.deleteRoom(roomId);
      logger.info({ roomId }, 'LiveKit room closed');
    } catch (err: any) {
      // Room may already be gone — don't throw
      if (err?.message?.includes('not found')) {
        logger.warn({ roomId }, 'LiveKit room already deleted');
        return;
      }
      logger.error({ err, roomId }, 'Failed to close LiveKit room');
      throw err;
    }
  }

  // ─── Issue Join Token ───────────────────────────────────────────────────

  async issueJoinToken(
    userId: string,
    roomId: string,
    displayName: string
  ): Promise<VideoToken> {
    const ttl = 3600; // 1 hour

    const grant: VideoGrant = {
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    };

    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userId,
      name: displayName,
      ttl,
    });

    token.addGrant(grant);

    const jwt = await token.toJwt();
    const expiresAt = new Date(Date.now() + ttl * 1000);

    logger.debug({ userId, roomId }, 'LiveKit join token issued');

    return {
      token: jwt,
      roomId,
      userId,
      expiresAt,
    };
  }

  // ─── Move Participant ───────────────────────────────────────────────────

  async moveParticipant(
    userId: string,
    fromRoomId: string,
    toRoomId: string
  ): Promise<void> {
    try {
      // Remove from current room
      await this.roomService.removeParticipant(fromRoomId, userId);
    } catch (err: any) {
      // Participant may already be gone from source room
      logger.warn({ userId, fromRoomId }, 'Could not remove participant from source room');
    }

    // A new join token must be issued for the destination room.
    // The client uses the token to join. The actual move is client-driven
    // after receiving the routing event + new token.
    logger.info({ userId, fromRoomId, toRoomId }, 'Participant move initiated');
  }

  // ─── List Participants ──────────────────────────────────────────────────

  async listParticipants(roomId: string): Promise<VideoParticipant[]> {
    try {
      const participants = await this.roomService.listParticipants(roomId);

      return participants.map(p => ({
        userId: p.identity,
        roomId,
        joinedAt: new Date(Number(p.joinedAt) * 1000),
        isConnected: p.state === 1, // ACTIVE state
      }));
    } catch (err: any) {
      if (err?.message?.includes('not found')) {
        return [];
      }
      logger.error({ err, roomId }, 'Failed to list participants');
      throw err;
    }
  }

  // ─── Room Exists ────────────────────────────────────────────────────────

  async roomExists(roomId: string): Promise<boolean> {
    try {
      const rooms = await this.roomService.listRooms([roomId]);
      return rooms.length > 0;
    } catch {
      return false;
    }
  }
}
