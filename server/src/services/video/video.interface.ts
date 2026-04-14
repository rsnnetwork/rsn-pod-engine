// ─── Video Provider Interface ────────────────────────────────────────────────
// Abstraction layer for video providers. Never couple orchestration to a
// specific provider SDK. Implementations must fulfill this contract.

import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';

export interface IVideoProvider {
  /** Create a room of the specified type. */
  createRoom(roomId: string, type: RoomType, sessionId: string): Promise<VideoRoom>;

  /** Close and destroy a room. */
  closeRoom(roomId: string): Promise<void>;

  /** Issue a join token for a user to enter a room. */
  issueJoinToken(userId: string, roomId: string, displayName: string, tokenTtl?: number): Promise<VideoToken>;

  /** Move a participant from one room to another (leave + join). */
  moveParticipant(userId: string, fromRoomId: string, toRoomId: string): Promise<void>;

  /** List current participants in a room. */
  listParticipants(roomId: string): Promise<VideoParticipant[]>;

  /** Check if a room exists. */
  roomExists(roomId: string): Promise<boolean>;
}
