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

    connectSocket(token);
    const socket = getSocket();

    socket.emit('session:join', { sessionId });

    // ── Participants ──
    socket.on('participant:joined', (data: any) =>
      store.addParticipant({ userId: data.userId, displayName: data.displayName }));
    socket.on('participant:left', (data: any) => store.removeParticipant(data.userId));
    socket.on('participant:count', () => { /* count managed via join/leave */ });

    // ── Session lifecycle ──
    socket.on('session:status_changed', (data: any) => {
      if (data.status === 'completed') { clearTimer(); store.setPhase('complete'); }
      if (data.currentRound) store.setRound(data.currentRound);
    });

    socket.on('session:round_started', (data: any) => {
      store.setRound(data.roundNumber);
      store.setByeRound(false);
      const duration = Math.floor((new Date(data.endsAt).getTime() - Date.now()) / 1000);
      store.setTimer(Math.max(0, duration));
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);
    });

    socket.on('session:round_ended', () => { clearTimer(); store.setPhase('rating'); });

    socket.on('session:completed', () => { clearTimer(); store.setPhase('complete'); });

    // ── Matching ──
    socket.on('match:assigned', (data: any) => {
      store.setByeRound(false);
      store.setMatch({ userId: data.partnerId, displayName: data.partnerId }, data.matchId);
      store.setPhase('matched');
      // Fetch LiveKit token for video
      api.post(`/sessions/${sessionId}/token`).then(res => {
        const { token, livekitUrl } = res.data.data;
        store.setLiveKitToken(token, livekitUrl);
      }).catch(() => { /* token fetch failed — video won't load but session continues */ });
    });

    socket.on('match:reassigned', (data: any) => {
      store.setMatch({ userId: data.newPartnerId, displayName: data.newPartnerId }, data.matchId || null);
      store.setPhase('matched');
      // Re-fetch token for new room
      api.post(`/sessions/${sessionId}/token`).then(res => {
        const { token, livekitUrl } = res.data.data;
        store.setLiveKitToken(token, livekitUrl);
      }).catch(() => {});
    });

    socket.on('match:bye_round', () => {
      store.setByeRound(true);
      store.setMatch(null);
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

    socket.on('rating:window_closed', () => { clearTimer(); store.setPhase('lobby'); });

    // ── Host broadcasts ──
    socket.on('host:broadcast', (data: any) => store.addBroadcast(data.message));

    socket.on('host:participant_removed', () => {
      store.setError('You have been removed from this session.');
      store.setPhase('complete');
    });

    // ── Sync & errors ──
    socket.on('timer:sync', (data: any) => store.setTimer(data.secondsRemaining));

    socket.on('error', (data: any) => store.setError(data.message || 'An error occurred'));

    // ── Reconnection ──
    socket.io.on('reconnect', () => {
      store.setReconnecting(false);
      store.setError(null);
      socket.emit('session:join', { sessionId });
    });

    socket.io.on('reconnect_attempt', () => store.setReconnecting(true));
    socket.io.on('reconnect_failed', () => {
      store.setReconnecting(false);
      store.setError('Connection lost. Please refresh the page.');
    });

    return () => {
      clearTimer();
      socket.emit('session:leave', { sessionId });
      disconnectSocket();
    };
  }, [sessionId]);
}
