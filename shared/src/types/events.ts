// ─── Real-Time Socket Event Types ────────────────────────────────────────────

// Server -> Client events
export interface ServerToClientEvents {
  // Session lifecycle
  'session:status_changed': (data: { sessionId: string; status: string; currentRound: number }) => void;
  'session:round_started': (data: { sessionId: string; roundNumber: number; totalRounds?: number; endsAt: string }) => void;
  'session:round_ending': (data: { sessionId: string; roundNumber: number; secondsLeft: number }) => void;
  'session:round_ended': (data: { sessionId: string; roundNumber: number }) => void;
  'session:completed': (data: { sessionId: string }) => void;

  // Matching & routing
  'match:assigned': (data: { matchId: string; partnerId: string; partnerDisplayName?: string; roomId: string; roundNumber: number }) => void;
  'match:bye_round': (data: { roundNumber: number; reason: string }) => void;
  'match:reassigned': (data: { matchId: string; newPartnerId: string; partnerDisplayName?: string; roomId: string }) => void;

  // Participant events
  'participant:joined': (data: { userId: string; displayName: string; isHost?: boolean }) => void;
  'participant:left': (data: { userId: string; isHost?: boolean }) => void;
  'participant:count': (data: { count: number }) => void;
  'session:state': (data: {
    participants: { userId: string; displayName: string }[];
    sessionStatus?: string;
    hostInLobby?: boolean;
    currentRound?: number;
    totalRounds?: number;
  }) => void;

  // Rating window
  'rating:window_open': (data: { matchId: string; partnerId: string; roundNumber: number; durationSeconds: number }) => void;
  'rating:window_closed': (data: { roundNumber: number }) => void;

  // Host actions
  'host:broadcast': (data: { message: string; sentAt: string }) => void;
  'host:participant_removed': (data: { userId: string; reason: string }) => void;

  // Lobby video
  'lobby:token': (data: { token: string; livekitUrl: string; roomId: string }) => void;

  // Timer sync
  'timer:sync': (data: { segmentType: string; secondsRemaining: number; totalSeconds: number }) => void;

  // Errors
  'error': (data: { code: string; message: string }) => void;
}

// Client -> Server events
export interface ClientToServerEvents {
  // Session
  'session:join': (data: { sessionId: string }) => void;
  'session:leave': (data: { sessionId: string }) => void;

  // Presence
  'presence:heartbeat': (data: { sessionId: string }) => void;
  'presence:ready': (data: { sessionId: string }) => void;

  // Rating
  'rating:submit': (data: { matchId: string; qualityScore: number; meetAgain: boolean; feedback?: string }) => void;

  // Host controls
  'host:start_session': (data: { sessionId: string }) => void;
  'host:start_round': (data: { sessionId: string }) => void;
  'host:pause_session': (data: { sessionId: string }) => void;
  'host:resume_session': (data: { sessionId: string }) => void;
  'host:end_session': (data: { sessionId: string }) => void;
  'host:broadcast_message': (data: { sessionId: string; message: string }) => void;
  'host:remove_participant': (data: { sessionId: string; userId: string; reason: string }) => void;
  'host:reassign': (data: { sessionId: string; participantId: string }) => void;
}
