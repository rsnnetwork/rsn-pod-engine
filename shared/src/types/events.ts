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
  'match:assigned': (data: { matchId: string; partnerId: string; partnerDisplayName?: string; partners?: { userId: string; displayName: string }[]; roomId: string; roundNumber: number }) => void;
  'match:bye_round': (data: { roundNumber: number; reason: string }) => void;
  'match:reassigned': (data: { matchId: string; newPartnerId: string; partnerDisplayName?: string; roomId: string; roundNumber?: number }) => void;
  'match:partner_disconnected': (data: { matchId?: string }) => void;
  'match:partner_reconnected': (data: { matchId?: string }) => void;

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
    timerVisibility?: string;
  }) => void;

  // Rating window
  'rating:window_open': (data: { matchId: string; partnerId: string; partnerDisplayName?: string; partners?: { userId: string; displayName: string }[]; roundNumber: number; durationSeconds: number }) => void;
  'rating:window_closed': (data: { roundNumber: number }) => void;

  // Host actions
  'host:broadcast': (data: { message: string; sentAt: string }) => void;
  'host:participant_removed': (data: { userId: string; reason: string }) => void;
  'host:match_preview': (data: {
    roundNumber: number;
    matches: { participantA: { userId: string; displayName: string }; participantB: { userId: string; displayName: string }; participantC?: { userId: string; displayName: string }; isTrio?: boolean; metBefore?: boolean; timesMet?: number }[];
    byeParticipants: { userId: string; displayName: string }[];
  }) => void;

  // Host round dashboard (breakout room monitoring)
  'host:round_dashboard': (data: {
    roundNumber: number;
    rooms: { matchId: string; roomId: string; status: string; participants: { userId: string; displayName: string; isConnected: boolean }[]; isTrio: boolean }[];
    byeParticipants: { userId: string; displayName: string }[];
    timerSecondsRemaining: number;
    reassignmentInProgress: boolean;
  }) => void;
  'host:room_status_update': (data: {
    matchId: string;
    status: string;
    participants: { userId: string; displayName: string; isConnected: boolean }[];
  }) => void;

  // Breakout room
  'match:return_to_lobby': (data: { reason: 'partner_left' | 'you_left' | 'auto_return' }) => void;

  // Matching anticipation
  'session:matching_in_progress': (data: { sessionId: string; roomCount: number; roundNumber: number }) => void;

  // Reactions
  'reaction:received': (data: { userId: string; displayName: string; type: string; timestamp: string }) => void;

  // Lobby video
  'lobby:token': (data: { token: string; livekitUrl: string; roomId: string }) => void;
  'lobby:mute_command': (data: { muted: boolean; byHost: boolean }) => void;

  // Chat
  'chat:message': (data: { id: string; userId: string; displayName: string; message: string; timestamp: string; scope: 'lobby' | 'room'; isHost: boolean }) => void;
  'chat:history': (data: { messages: { id: string; userId: string; displayName: string; message: string; timestamp: string; scope: 'lobby' | 'room'; isHost: boolean }[] }) => void;

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
  'host:generate_matches': (data: { sessionId: string }) => void;
  'host:confirm_round': (data: { sessionId: string }) => void;
  'host:swap_match': (data: { sessionId: string; userA: string; userB: string }) => void;
  'host:exclude_participant': (data: { sessionId: string; userId: string }) => void;
  'host:regenerate_matches': (data: { sessionId: string }) => void;
  'host:mute_participant': (data: { sessionId: string; targetUserId: string; muted: boolean }) => void;
  'host:mute_all': (data: { sessionId: string; muted: boolean }) => void;
  'host:remove_from_room': (data: { sessionId: string; matchId: string; userId: string }) => void;

  // Breakout room
  'participant:leave_conversation': (data: { sessionId: string }) => void;

  // Reactions
  'reaction:send': (data: { sessionId: string; type: string }) => void;

  // Chat
  'chat:send': (data: { sessionId: string; message: string; scope: 'lobby' | 'room' }) => void;
}
