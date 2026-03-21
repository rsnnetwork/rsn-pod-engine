import { useEffect, useRef } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import api from '@/lib/api';

// All socket event names we listen to — used for deterministic cleanup
const SOCKET_EVENTS = [
  'participant:joined', 'participant:left', 'participant:count',
  'session:state', 'session:status_changed', 'session:round_started',
  'session:round_ended', 'session:completed',
  'match:assigned', 'match:reassigned', 'match:bye_round',
  'match:partner_disconnected', 'match:partner_reconnected', 'match:return_to_lobby',
  'rating:window_open', 'rating:window_closed',
  'session:matching_in_progress',
  'host:broadcast', 'lobby:token', 'host:participant_removed',
  'host:match_preview', 'lobby:mute_command',
  'host:round_dashboard', 'host:room_status_update',
  'chat:message', 'chat:history',
  'timer:sync', 'error',
  'cohost:assigned', 'cohost:removed',
] as const;

export default function useSessionSocket(sessionId: string) {
  const store = useSessionStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initializedRef = useRef<string | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  useEffect(() => {
    const token = localStorage.getItem('rsn_access');
    if (!token || !sessionId) return;

    // Prevent double-initialization for the same session (React strict mode)
    if (initializedRef.current === sessionId) return;
    initializedRef.current = sessionId;

    // Reset store on mount
    store.reset();

    // Auto-register participant (ignore if already registered)
    api.post(`/sessions/${sessionId}/register`).catch(() => {});

    connectSocket(token);
    const socket = getSocket();

    // Remove any stale listeners from a previous mount before adding new ones
    for (const ev of SOCKET_EVENTS) socket.off(ev);

    // Track connection status
    store.setConnectionStatus('connecting');

    // Send presence heartbeats every 15 seconds so server knows we're alive
    const heartbeatInterval = setInterval(() => {
      socket.emit('presence:heartbeat', { sessionId });
    }, 15000);

    // Wait for connection before joining session
    const joinSession = () => {
      store.setConnectionStatus('connected');
      socket.emit('session:join', { sessionId });
    };

    if (socket.connected) {
      joinSession();
    } else {
      socket.once('connect', joinSession);
    }

    // ── Participants ──
    socket.on('participant:joined', (data: any) => {
      store.addParticipant({ userId: data.userId, displayName: data.displayName });
      if (data.isHost) store.setHostInLobby(true);
    });
    socket.on('participant:left', (data: any) => {
      store.removeParticipant(data.userId);
      if (data.isHost) store.setHostInLobby(false);
    });
    socket.on('participant:count', () => { /* count managed via join/leave */ });
    socket.on('session:state', (data: any) => {
      if (data.participants) store.setParticipants(data.participants);
      if (data.sessionStatus) store.setSessionStatus(data.sessionStatus);
      if (data.hostInLobby !== undefined) store.setHostInLobby(data.hostInLobby);
      if (data.hostUserId) store.setHostUserId(data.hostUserId);
      if (data.currentRound !== undefined) store.setRound(data.currentRound);
      if (data.totalRounds !== undefined) store.setTotalRounds(data.totalRounds);
      if (data.timerVisibility) store.setTimerVisibility(data.timerVisibility);
      if (data.cohosts) store.setCohosts(data.cohosts);
    });

    // ── Co-host ──
    socket.on('cohost:assigned', (data: any) => { store.addCohost(data.userId); });
    socket.on('cohost:removed', (data: any) => { store.removeCohost(data.userId); });

    // ── Session lifecycle ──
    socket.on('session:status_changed', (data: any) => {
      store.setSessionStatus(data.status);
      if (data.status === 'completed') { clearTimer(); store.setLiveKitToken(null, null); store.setMatch(null); store.setRoomId(null); store.setMatchingOverlay(null); store.setRoundDashboard(null); store.setTransitionStatus('session_ending'); setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500); }
      if (data.status === 'lobby_open') store.setTransitionStatus('starting_session');
      if (data.status === 'closing_lobby') {
        // Closing lobby: clear match data, return to lobby with closing overlay
        store.setLiveKitToken(null, null);
        store.setMatch(null);
        store.setRoomId(null);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus('session_ending');
        store.setPhase('lobby');
      }
      // Handle round_rating — only transition matched participants to rating
      if (data.status === 'round_rating') {
        clearTimer();
        const state = useSessionStore.getState();
        // Skip if we already rated this round (prevents late-arriving status from overriding lobby)
        if (state.currentRound <= state.lastRatedRound) return;
        // Bye-round users stay in lobby — they have no match to rate
        if (state.isByeRound) {
          store.setTransitionStatus('between_rounds');
          // Don't change phase — keep them in lobby
        } else if (state.phase !== 'rating') {
          // Matched users who didn't get rating:window_open (edge case) — transition them
          store.setTransitionStatus('round_ending');
          store.setPhase('rating');
        }
      }
      // Handle round_transition — ensure all clients return to lobby immediately
      if (data.status === 'round_transition') {
        clearTimer();
        store.setLiveKitToken(null, null);
        setTimeout(() => { store.setMatch(null); store.setRoomId(null); }, 500);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus(null);
        store.setPhase('lobby');
      }
      if (data.currentRound) store.setRound(data.currentRound);
    });

    socket.on('session:round_started', (data: any) => {
      store.setRound(data.roundNumber);
      if (data.totalRounds) store.setTotalRounds(data.totalRounds);
      store.setByeRound(false);
      store.setLeftCurrentRound(false); // New round — allow matching
      store.setPartnerDisconnected(false);
      store.setTransitionStatus(null);
      store.setMatchPreview(null);
      const duration = Math.floor((new Date(data.endsAt).getTime() - Date.now()) / 1000);
      store.setTimer(Math.max(0, duration));
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);
    });

    socket.on('session:round_ended', () => {
      clearTimer();
      store.setRoundDashboard(null); // Clear host dashboard
      const state = useSessionStore.getState();
      if (state.isByeRound) {
        // Bye-round users have no match to rate — stay in lobby
        store.setTransitionStatus('between_rounds');
      } else {
        store.setTransitionStatus('round_ending');
        // Preserve currentMatch/currentMatchId so RatingPrompt can use them
        store.setPhase('rating');
      }
    });

    socket.on('session:completed', () => {
      clearTimer();
      // session:completed always wins — force complete phase, clear ALL transient state
      store.setLiveKitToken(null, null);
      store.setMatch(null);
      store.setRoomId(null);
      store.setByeRound(false);
      store.setPartnerDisconnected(false);
      store.setMatchingOverlay(null);
      store.setLeftCurrentRound(false);
      store.setRoundDashboard(null);
      store.setTransitionStatus('session_ending');
      // Small delay so in-progress rating submissions can finish
      setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500);
    });

    // ── Matching anticipation ──
    socket.on('session:matching_in_progress', (data: any) => {
      store.setMatchingOverlay({ roomCount: data.roomCount, roundNumber: data.roundNumber });
    });

    // ── Matching ──
    socket.on('match:assigned', (data: any) => {
      // Only transition to 'matched' phase during an active round — ignore stale
      // match:assigned events that arrive during rating or lobby transitions
      const state = useSessionStore.getState();
      if (state.sessionStatus === 'round_rating' || state.sessionStatus === 'completed') return;
      if (state.sessionStatus === 'round_transition') return;
      if (state.leftCurrentRound) return; // User manually left this round

      store.setMatchingOverlay(null); // Clear anticipation screen
      store.setByeRound(false);
      store.setPartnerDisconnected(false);
      store.setTransitionStatus('preparing_match');
      const partners = data.partners || [{ userId: data.partnerId, displayName: data.partnerDisplayName || data.partnerId }];
      store.setMatch({ userId: data.partnerId, displayName: data.partnerDisplayName || data.partnerId }, data.matchId, partners);
      store.setPhase('matched');
      // Store roomId for VideoRoom backup fetch
      if (data.roomId) store.setRoomId(data.roomId);
      // Fetch LiveKit token for the match-specific video room
      api.post(`/sessions/${sessionId}/token`, { roomId: data.roomId }).then(res => {
        const { token, livekitUrl } = res.data.data;
        store.setLiveKitToken(token, livekitUrl);
        store.setTransitionStatus(null);
      }).catch(() => { store.setTransitionStatus(null); });
    });

    socket.on('match:reassigned', (data: any) => {
      // Same guards as match:assigned
      const reassignState = useSessionStore.getState();
      if (reassignState.sessionStatus === 'round_rating' || reassignState.sessionStatus === 'completed') return;
      if (reassignState.sessionStatus === 'round_transition') return;
      if (reassignState.leftCurrentRound) return;
      store.setPartnerDisconnected(false);
      store.setTransitionStatus('preparing_match');
      store.setMatch({ userId: data.newPartnerId, displayName: data.partnerDisplayName || data.newPartnerId }, data.matchId || null);
      store.setPhase('matched');
      // Re-fetch token for new room
      api.post(`/sessions/${sessionId}/token`, { roomId: data.roomId }).then(res => {
        const { token, livekitUrl } = res.data.data;
        store.setLiveKitToken(token, livekitUrl);
        store.setTransitionStatus(null);
      }).catch(() => { store.setTransitionStatus(null); });
    });

    socket.on('match:partner_disconnected', () => {
      store.setPartnerDisconnected(true);
    });

    socket.on('match:partner_reconnected', () => {
      store.setPartnerDisconnected(false);
    });

    socket.on('match:return_to_lobby', () => {
      // Returned to lobby from breakout room (left conversation or partner left)
      store.setLiveKitToken(null, null);
      store.setMatch(null);
      store.setRoomId(null);
      store.setByeRound(false);
      store.setPartnerDisconnected(false);
      store.setTransitionStatus(null);
      store.setLeftCurrentRound(true); // Prevent re-entry via stale match:assigned
      store.setPhase('lobby');
    });

    socket.on('match:bye_round', () => {
      store.setMatchingOverlay(null);
      store.setByeRound(true);
      store.setPartnerDisconnected(false);
      store.setMatch(null);
      store.setTransitionStatus(null);
      store.setPhase('lobby');
    });

    // ── Ratings ──
    socket.on('rating:window_open', (data: any) => {
      // Only process if we're actually in rating phase
      const currentState = useSessionStore.getState();
      if (currentState.sessionStatus !== 'round_rating' && currentState.sessionStatus !== 'round_active') return;
      if (data.partners && data.partners.length > 0) {
        // Server sent full partner info (reconnect or trio) — use it
        const primaryPartner = data.partners[0];
        store.setMatch(
          { userId: primaryPartner.userId, displayName: primaryPartner.displayName || data.partnerDisplayName || primaryPartner.userId },
          data.matchId || currentState.currentMatchId,
          data.partners,
        );
      } else if (data.matchId) {
        // Normal case: preserve existing match data, just update matchId
        store.setMatch(currentState.currentMatch, data.matchId, currentState.currentPartners);
      }
      store.setTimer(data.durationSeconds || 30);
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);
      store.setPhase('rating');
    });

    socket.on('rating:window_closed', () => {
      clearTimer();
      store.setLiveKitToken(null, null);
      const state = useSessionStore.getState();
      store.setLastRatedRound(state.currentRound); // Prevent re-entry to rating for this round
      // Don't clear match data immediately — let RatingPrompt finish if user is mid-submit.
      setTimeout(() => {
        store.setMatch(null);
        store.setRoomId(null);
      }, 500);
      // Return to lobby immediately — no transition delay
      const isLastRound = state.currentRound >= state.totalRounds && state.totalRounds > 0;
      if (isLastRound) {
        store.setTransitionStatus('session_ending');
      } else {
        store.setTransitionStatus(null);
      }
      store.setPhase('lobby');
    });

    // ── Host broadcasts ──
    socket.on('host:broadcast', (data: any) => store.addBroadcast(data.message));

    // ── Lobby video ──
    socket.on('lobby:token', (data: any) => {
      store.setLobbyToken(data.token, data.livekitUrl, data.roomId);
    });

    socket.on('lobby:mute_command', (data: any) => {
      store.setHostMuteCommand(data.muted);
    });

    socket.on('host:participant_removed', () => {
      store.setError('You have been removed from this event.');
      store.setPhase('complete');
    });

    socket.on('host:match_preview', (data: any) => {
      store.setMatchPreview(data);
    });

    // ── Host round dashboard (breakout room monitoring) ──
    socket.on('host:round_dashboard', (data: any) => {
      store.setRoundDashboard(data);
    });

    socket.on('host:room_status_update', (data: any) => {
      store.updateRoomStatus(data.matchId, data.status, data.participants);
    });

    // ── Chat ──
    socket.on('chat:message', (data: any) => store.addChatMessage(data));
    socket.on('chat:history', (data: any) => {
      if (data.messages && Array.isArray(data.messages)) {
        store.setChatMessages(data.messages);
      }
    });

    // ── Sync & errors ──
    socket.on('timer:sync', (data: any) => store.setTimer(data.secondsRemaining));

    socket.on('error', (data: any) => {
      // Don't show transient errors as persistent banners
      const msg = data.message || 'An error occurred';
      store.setError(msg);
      // Auto-clear non-critical errors after 5 seconds
      setTimeout(() => {
        const current = useSessionStore.getState().error;
        if (current === msg) store.setError(null);
      }, 5000);
    });

    // ── Reconnection ──
    const onReconnect = () => {
      store.setReconnecting(false);
      store.setConnectionStatus('connected');
      store.setError(null);
      socket.emit('session:join', { sessionId });
    };

    const onReconnectAttempt = () => {
      store.setReconnecting(true);
      store.setConnectionStatus('reconnecting');
    };

    const onReconnectFailed = () => {
      store.setReconnecting(false);
      store.setConnectionStatus('disconnected');
      store.setError('Connection lost. Please refresh the page.');
    };

    socket.io.on('reconnect', onReconnect);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.io.on('reconnect_failed', onReconnectFailed);

    return () => {
      clearTimer();
      clearInterval(heartbeatInterval);

      // Remove ALL socket event listeners we attached
      for (const ev of SOCKET_EVENTS) socket.off(ev);
      socket.off('connect', joinSession);
      socket.io.off('reconnect', onReconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect_failed', onReconnectFailed);

      // Leave the session room and disconnect
      socket.emit('session:leave', { sessionId });
      disconnectSocket();

      // Allow re-initialization if this effect re-runs
      initializedRef.current = null;
    };
  }, [sessionId]);
}
