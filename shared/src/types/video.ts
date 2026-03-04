// ─── Video Abstraction Types ─────────────────────────────────────────────────

export enum RoomType {
  LOBBY = 'lobby',
  ONE_TO_ONE = 'one_to_one',
  HOST_CONTROL = 'host_control',
}

export interface VideoRoom {
  roomId: string;
  type: RoomType;
  sessionId: string;
  participantCount: number;
  createdAt: Date;
}

export interface VideoToken {
  token: string;
  roomId: string;
  userId: string;
  expiresAt: Date;
}

export interface VideoParticipant {
  userId: string;
  roomId: string;
  joinedAt: Date;
  isConnected: boolean;
}
