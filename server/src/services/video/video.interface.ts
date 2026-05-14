// ─── Video Provider Interface ────────────────────────────────────────────────
// Abstraction layer for video providers. Never couple orchestration to a
// specific provider SDK. Implementations must fulfill this contract.

import { RoomType, VideoRoom, VideoToken, VideoParticipant } from '@rsn/shared';

export { RoomType };

export interface IVideoProvider {
  /** Create a room. `emptyTimeoutSeconds` — auto-delete after being empty this long (default 300). */
  createRoom(roomId: string, type: RoomType, sessionId: string, emptyTimeoutSeconds?: number): Promise<VideoRoom>;

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

  /**
   * Phase U (12 May spec item 7 — LiveKit-level mute enforcement).
   * Update a participant's publish permission on the live SFU. When
   * `canPublishAudio = false`, the participant cannot publish audio
   * tracks regardless of client UI state — true server-enforced mute.
   * Re-grant with `true` on host unmute.
   *
   * No-op when the participant is not currently in the room (eg.
   * disconnected or already removed). Implementations should swallow
   * "participant not found" errors and return cleanly.
   */
  setParticipantCanPublishAudio(roomId: string, userId: string, canPublishAudio: boolean): Promise<void>;
}
