// ─── Real-Time Socket Event Types ────────────────────────────────────────────

// Server -> Client events
export interface ServerToClientEvents {
  // Session lifecycle
  'session:status_changed': (data: { sessionId: string; status: string; currentRound: number }) => void;
  'session:round_started': (data: { sessionId: string; roundNumber: number; totalRounds?: number; endsAt: string }) => void;
  'session:round_ending': (data: { sessionId: string; roundNumber: number; secondsLeft: number }) => void;
  'session:round_ended': (data: { sessionId: string; roundNumber: number }) => void;
  'session:completed': (data: { sessionId: string }) => void;
  'session:evicted': (data: { reason: string }) => void;

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
    hostUserId?: string;
    currentRound?: number;
    totalRounds?: number;
    timerVisibility?: string;
    cohosts?: string[];
    // Phase 5B (5 May spec) — test-mode banner surface.
    testMode?: boolean;
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

  // Phase 2.5A (5 May spec compliance) — fired when the host clicks Start
  // Event and the engine successfully generates the full multi-round plan
  // upfront. UI uses this to show "Plan ready — N rounds, M pairs" feedback.
  'host:event_plan_generated': (data: {
    sessionId: string;
    roundCount: number;
    totalPairs: number;
  }) => void;

  // Phase 2.5D (5 May spec §9) — fired when future rounds are auto-repaired
  // after a participant joined late or left mid-event. Host UI uses this to
  // show "Plan updated for rounds X-Y" toast + reflect the new pairings in
  // any visible upcoming-rounds view.
  'host:event_plan_repaired': (data: {
    sessionId: string;
    reason: 'late_joiner' | 'left' | 'host_request';
    regeneratedRounds: number[];
  }) => void;

  // Host round dashboard (breakout room monitoring).
  // Phase 7C.1 (7 May spec, Stefan #3 + #11) — `participants` field added
  // to back the Host Control Center drawer. Optional for forward
  // compatibility with older server versions on reconnect paths.
  'host:round_dashboard': (data: {
    roundNumber: number;
    rooms: { matchId: string; roomId: string; status: string; participants: { userId: string; displayName: string; isConnected: boolean }[]; isTrio: boolean }[];
    byeParticipants: { userId: string; displayName: string }[];
    timerSecondsRemaining: number;
    reassignmentInProgress: boolean;
    // Phase 8A.2 — number of main-room participants actually connected
    // right now (intersection of eligibleMainRoomCount with presenceMap).
    presentMainRoomCount?: number;
    participants?: Array<{
      userId: string;
      displayName: string;
      email: string | null;
      role: 'host' | 'cohost' | 'participant';
      state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
      currentMatchId: string | null;
      currentRoomId: string | null;
      joinedAt: string;
    }>;
  }) => void;
  'host:room_status_update': (data: {
    matchId: string;
    status: string;
    participants: { userId: string; displayName: string; isConnected: boolean }[];
  }) => void;

  // Breakout room
  'match:return_to_lobby': (data: { reason: 'partner_left' | 'you_left' | 'auto_return' }) => void;

  // Matching anticipation
  'session:matching_preparing': (data: { sessionId: string; roundNumber: number }) => void;
  'session:matching_in_progress': (data: { sessionId: string; roomCount: number; roundNumber: number }) => void;
  'session:matching_cancelled': (data: { sessionId: string }) => void;
  'session:matches_confirmed': (data: { sessionId: string; matchCount: number; roundNumber: number }) => void;

  // Co-host
  'cohost:assigned': (data: { userId: string; displayName: string; role: string }) => void;
  'cohost:removed': (data: { userId: string }) => void;
  // T1-5 — host transferred ownership to a co-host
  'host:transferred': (data: { sessionId: string; previousHostId: string; newHostId: string; newHostDisplayName: string }) => void;
  // T1-5 — direct permission update sent to a user's personal room when
  // their effective role in a session changes (cohost assigned/removed/
  // promoted). Lets the client re-render host-only controls without
  // polling or refresh.
  'permissions:updated': (data: { sessionId: string; effectiveRole: 'pod_admin' | 'event_host' | 'cohost' | 'participant'; capabilities: string[] }) => void;
  // Phase G (10 May spec item 11) — host or co-host visibility mode changed.
  'host:visibility_changed': (data: { sessionId: string; userId: string; mode: 'big_speaker' | 'normal' | 'producer' | 'hidden' }) => void;

  // Reactions
  'reaction:received': (data: { userId: string; displayName: string; type: string; timestamp: string }) => void;

  // Lobby video
  'lobby:token': (data: { token: string; livekitUrl: string; roomId: string }) => void;
  'lobby:mute_command': (data: { muted: boolean; byHost: boolean }) => void;

  // Chat
  'chat:message': (data: { id: string; userId: string; displayName: string; message: string; timestamp: string; scope: 'lobby' | 'room'; isHost: boolean; reactions?: Record<string, string[]> }) => void;
  'chat:history': (data: { messages: { id: string; userId: string; displayName: string; message: string; timestamp: string; scope: 'lobby' | 'room'; isHost: boolean; reactions?: Record<string, string[]> }[] }) => void;
  'chat:reaction_update': (data: { messageId: string; reactions: Record<string, string[]> }) => void;

  // Timer sync
  'timer:sync': (data: { segmentType: string; secondsRemaining: number; totalSeconds: number }) => void;

  // Notifications (real-time push)
  'notification:new': (data: { id: string; type: string; title: string; body?: string; link?: string; isRead: boolean; createdAt: string; inviteStatus?: string; podId?: string | null; sessionId?: string | null }) => void;

  // DM (Phase D of chat-fix-and-dm-system, 1 May 2026) — platform-level
  // person-to-person messaging. Independent of any session/round/event.
  'dm:message': (data: { id: string; conversationId: string; fromUserId: string; content: string; readAt: string | null; createdAt: string }) => void;
  'dm:conversation_updated': (data: { conversationId: string; lastMessageAt: string; lastMessage: string; lastMessageFromUserId: string }) => void;
  'dm:read_receipt': (data: { conversationId: string; readBy: string; readAt: string; markedCount: number }) => void;
  // Phase E (3 May 2026) — emoji reactions on direct messages.
  'dm:reaction_added': (data: { messageId: string; conversationId: string; userId: string; emoji: string }) => void;
  'dm:reaction_removed': (data: { messageId: string; conversationId: string; userId: string; emoji: string }) => void;

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
  // T0-2 (Issue 7) — fired by client after LiveKit room.connect() resolves.
  // Distinct from presence:ready: confirms LiveKit room membership specifically.
  'presence:room_joined': (data: { sessionId: string; matchId: string; roomId: string }) => void;

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
  'host:cancel_preview': (data: { sessionId: string }) => void;
  'host:force_match': (data: { sessionId: string; userIdA: string; userIdB: string }) => void;
  'host:move_to_room': (data: { sessionId: string; userId: string; targetMatchId: string }) => void;
  'host:mute_participant': (data: { sessionId: string; targetUserId: string; muted: boolean }) => void;
  'host:mute_all': (data: { sessionId: string; muted: boolean }) => void;
  'host:remove_from_room': (data: { sessionId: string; matchId: string; userId: string }) => void;

  // Breakout room
  'participant:leave_conversation': (data: { sessionId: string }) => void;

  // Timer extension
  'host:extend_round': (data: { sessionId: string; additionalSeconds: number }) => void;

  // Co-host
  'host:assign_cohost': (data: { sessionId: string; userId: string; role: 'co_host' | 'moderator' }) => void;
  'host:promote_cohost': (data: { sessionId: string; cohostUserId: string }) => void;
  'host:remove_cohost': (data: { sessionId: string; userId: string }) => void;

  // Reactions
  'reaction:send': (data: { sessionId: string; type: string; matchId?: string }) => void;

  // Chat
  'chat:send': (data: { sessionId: string; message: string; scope: 'lobby' | 'room' }) => void;
  'chat:react': (data: { sessionId: string; messageId: string; emoji: string }) => void;
  // Phase 4B (5 May spec) — force-fetch chat history on demand.
  'chat:request_history': (data: { sessionId: string; matchId?: string }) => void;

  // DM (Phase D of chat-fix-and-dm-system, 1 May 2026)
  'dm:send': (data: { toUserId: string; content: string }) => void;
  'dm:read': (data: { conversationId: string }) => void;
  // Phase E (3 May 2026) — emoji reactions on direct messages.
  'dm:react': (data: { messageId: string; emoji: string }) => void;
  'dm:unreact': (data: { messageId: string; emoji: string }) => void;
}
