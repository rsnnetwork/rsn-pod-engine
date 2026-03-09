import { useEffect, useRef } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import api from '@/lib/api';

export default function useSessionSocket(sessionId: string) {
  const store = useSessionStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  useEffect(() => {
    const token = localStorage.getItem('rsn_access');
    if (!token || !sessionId) return;

    // Reset store on mount
    store.reset();

    // Auto-register participant (ignore if already registered)
    api.post(`/sessions/${sessionId}/register`).catch(() => {});

    connectSocket(token);
    const socket = getSocket();

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
    socket.on('participant:joined', (data: any) =>
      store.addParticipant({ userId: data.userId, displayName: data.displayName }));
    socket.on('participant:left', (data: any) => store.removeParticipant(data.userId));
    socket.on('participant:count', () => { /* count managed via join/leave */ });

    // ── Session lifecycle ──
    socket.on('session:status_changed', (data: any) => {
      if (data.status === 'completed') { clearTimer(); store.setTransitionStatus('session_ending'); setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500); }
      if (data.status === 'lobby_open') store.setTransitionStatus('starting_session');
      if (data.currentRound) store.setRound(data.currentRound);
    });

    socket.on('session:round_started', (data: any) => {
      store.setRound(data.roundNumber);
      if (data.totalRounds) store.setTotalRounds(data.totalRounds);
      store.setByeRound(false);
      store.setTransitionStatus(null);
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
      store.setByeRound(false);
      store.setTransitionStatus('preparing_match');
      store.setMatch({ userId: data.partnerId, displayName: data.partnerId }, data.matchId);
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
      store.setTransitionStatus('preparing_match');
      store.setMatch({ userId: data.newPartnerId, displayName: data.newPartnerId }, data.matchId || null);
      store.setPhase('matched');
      // Re-fetch token for new room
      api.post(`/sessions/${sessionId}/token`, { roomId: data.roomId }).then(res => {
        const { token, livekitUrl } = res.data.data;
        store.setLiveKitToken(token, livekitUrl);
        store.setTransitionStatus(null);
      }).catch(() => { store.setTransitionStatus(null); });
    });

    socket.on('match:bye_round', () => {
      store.setByeRound(true);
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

    socket.on('rating:window_closed', () => { clearTimer(); store.setTransitionStatus('between_rounds'); store.setPhase('lobby'); setTimeout(() => store.setTransitionStatus(null), 3000); });

    // ── Host broadcasts ──
    socket.on('host:broadcast', (data: any) => store.addBroadcast(data.message));

    // ── Lobby video ──
    socket.on('lobby:token', (data: any) => {
      store.setLobbyToken(data.token, data.livekitUrl, data.roomId);
    });

    socket.on('host:participant_removed', () => {
      store.setError('You have been removed from this session.');
      store.setPhase('complete');
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
    socket.io.on('reconnect', () => {
      store.setReconnecting(false);
      store.setConnectionStatus('connected');
      store.setError(null);
      socket.emit('session:join', { sessionId });
    });

    socket.io.on('reconnect_attempt', () => {
      store.setReconnecting(true);
      store.setConnectionStatus('reconnecting');
    });
    socket.io.on('reconnect_failed', () => {
      store.setReconnecting(false);
      store.setConnectionStatus('disconnected');
      store.setError('Connection lost. Please refresh the page.');
    });

    return () => {
      clearTimer();
      clearInterval(heartbeatInterval);
      socket.off('connect', joinSession);
      socket.emit('session:leave', { sessionId });
      disconnectSocket();
    };
  }, [sessionId]);
}
