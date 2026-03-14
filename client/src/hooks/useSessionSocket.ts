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
  'match:partner_disconnected', 'match:partner_reconnected',
  'rating:window_open', 'rating:window_closed',
  'host:broadcast', 'lobby:token', 'host:participant_removed',
  'host:match_preview', 'lobby:mute_command',
  'timer:sync', 'error',
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
      if (data.currentRound !== undefined) store.setRound(data.currentRound);
      if (data.totalRounds !== undefined) store.setTotalRounds(data.totalRounds);
      if (data.timerVisibility) store.setTimerVisibility(data.timerVisibility);
    });

    // ── Session lifecycle ──
    socket.on('session:status_changed', (data: any) => {
      store.setSessionStatus(data.status);
      if (data.status === 'completed') { clearTimer(); store.setTransitionStatus('session_ending'); setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500); }
      if (data.status === 'lobby_open') store.setTransitionStatus('starting_session');
      if (data.status === 'closing_lobby') store.setTransitionStatus('session_ending');
      if (data.currentRound) store.setRound(data.currentRound);
    });

    socket.on('session:round_started', (data: any) => {
      store.setRound(data.roundNumber);
      if (data.totalRounds) store.setTotalRounds(data.totalRounds);
      store.setByeRound(false);
      store.setTransitionStatus(null);
      store.setMatchPreview(null);
      const duration = Math.floor((new Date(data.endsAt).getTime() - Date.now()) / 1000);
      store.setTimer(Math.max(0, duration));
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);
    });

    socket.on('session:round_ended', () => {
      clearTimer();
      store.setTransitionStatus('round_ending');
      // Preserve currentMatch/currentMatchId so RatingPrompt can use them
      store.setPhase('rating');
    });

    socket.on('session:completed', () => {
      clearTimer();
      store.setTransitionStatus('session_ending');
      // Small delay so in-progress rating submissions can finish
      setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500);
    });

    // ── Matching ──
    socket.on('match:assigned', (data: any) => {
      // Only transition to 'matched' phase during an active round — ignore stale
      // match:assigned events that arrive during rating or lobby transitions
      const currentStatus = useSessionStore.getState().sessionStatus;
      if (currentStatus === 'round_rating' || currentStatus === 'completed') return;

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

    socket.on('match:bye_round', () => {
      store.setByeRound(true);
      store.setPartnerDisconnected(false);
      store.setMatch(null);
      store.setTransitionStatus(null);
      store.setPhase('lobby');
    });

    // ── Ratings ──
    socket.on('rating:window_open', (data: any) => {
      if (data.matchId) store.setMatch(store.currentMatch, data.matchId);
      store.setTimer(data.durationSeconds || 30);
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);
      store.setPhase('rating');
    });

    socket.on('rating:window_closed', () => {
      clearTimer();
      store.setLiveKitToken(null, null);
      // Don't clear match data immediately — let RatingPrompt finish if user is mid-submit.
      // Delay cleanup slightly so any in-flight rating POST can complete.
      setTimeout(() => {
        store.setMatch(null);
        store.setRoomId(null);
      }, 500);
      // If this was the last round, show session ending; otherwise between rounds
      const state = useSessionStore.getState();
      const isLastRound = state.currentRound >= state.totalRounds && state.totalRounds > 0;
      store.setTransitionStatus(isLastRound ? 'session_ending' : 'between_rounds');
      store.setPhase('lobby');
      if (!isLastRound) setTimeout(() => store.setTransitionStatus(null), 3000);
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
      store.setError('You have been removed from this session.');
      store.setPhase('complete');
    });

    socket.on('host:match_preview', (data: any) => {
      store.setMatchPreview(data);
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
