import { useEffect, useRef } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import api from '@/lib/api';

// All socket event names we listen to — used for deterministic cleanup
const SOCKET_EVENTS = [
  'participant:joined', 'participant:left', 'participant:count',
  'session:state', 'session:status_changed', 'session:round_started',
  'session:round_ended', 'session:completed', 'session:evicted',
  'match:assigned', 'match:reassigned', 'match:bye_round',
  'match:partner_disconnected', 'match:partner_reconnected', 'match:return_to_lobby',
  'rating:window_open', 'rating:window_closed',
  'session:matching_preparing', 'session:matching_in_progress', 'session:matching_cancelled', 'session:matches_confirmed',
  'host:broadcast', 'lobby:token', 'host:participant_removed',
  'host:match_preview', 'lobby:mute_command',
  'host:round_dashboard', 'host:room_status_update',
  'chat:message', 'chat:history', 'chat:reaction_update',
  'timer:sync', 'error',
  'cohost:assigned', 'cohost:removed',
] as const;

// ── LiveKit token fetch with retry ──
// At 200+ participants, token API can be under load. Retry with backoff
// prevents users from needing to refresh to enter breakout rooms.
async function fetchTokenWithRetry(
  sessionId: string,
  roomId: string,
  maxRetries = 3,
): Promise<{ token: string; livekitUrl: string } | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await api.post(`/sessions/${sessionId}/token`, { roomId });
      return res.data.data;
    } catch {
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  return null;
}

export default function useSessionSocket(sessionId: string) {
  const store = useSessionStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ratingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const byeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef<string | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  const clearRatingFallback = () => {
    if (ratingFallbackRef.current) { clearTimeout(ratingFallbackRef.current); ratingFallbackRef.current = null; }
  };

  const clearByeTimeout = () => {
    if (byeTimeoutRef.current) { clearTimeout(byeTimeoutRef.current); byeTimeoutRef.current = null; }
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

    // FIX 4B: Remove ALL previous listeners before registering new ones
    // Prevents accumulation on mount/unmount cycles (React strict mode, fast nav)
    SOCKET_EVENTS.forEach(ev => socket.off(ev));
    socket.off('connect');
    socket.io.off('reconnect');
    socket.io.off('reconnect_attempt');
    socket.io.off('reconnect_failed');

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

    // ── Eviction (duplicate tab/device) ──
    socket.on('session:evicted', () => {
      store.setConnectionStatus('disconnected');
      store.setPhase('lobby');
      // Signal will be picked up by UI to show "connected from another tab" message
      store.setTransitionStatus('evicted');
    });

    // ── Session lifecycle ──
    socket.on('session:status_changed', (data: any) => {
      store.setSessionStatus(data.status);
      if (data.isPaused !== undefined) store.setIsPaused(data.isPaused);
      if (data.status === 'completed') { clearTimer(); clearByeTimeout(); store.setLiveKitToken(null, null); store.setMatch(null); store.setRoomId(null); store.setMatchingOverlay(null); store.setRoundDashboard(null); store.setByeRound(false); store.setPartnerDisconnected(false); store.setLeftCurrentRound(false); store.setTransitionStatus('session_ending'); setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500); }
      if (data.status === 'lobby_open') { store.setTransitionStatus(null); store.setHostInLobby(true); }
      if (data.status === 'round_active') { store.setLeftCurrentRound(false); } // New round — clear flag so match:assigned is accepted
      if (data.status === 'closing_lobby') {
        const currentState = useSessionStore.getState();
        store.setLiveKitToken(null, null);
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setTransitionStatus('session_ending');
        // If user is mid-rating, preserve match data so RatingPrompt can finish.
        // Match data will be cleared when rating completes or window_closed fires.
        if (currentState.phase !== 'rating') {
          store.setMatch(null);
          store.setRoomId(null);
          store.setPhase('lobby');
        }
        // If in rating phase, DON'T change phase — let RatingPrompt finish naturally.
        // The rating:window_closed handler or RatingPrompt's own allDone logic
        // will transition to lobby when rating is complete.
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
        store.setByeRound(false);
        store.setPartnerDisconnected(false);
        store.setMatchingOverlay(null);
        store.setLeftCurrentRound(false);
        store.setHostInLobby(true);
        const currentState = useSessionStore.getState();
        if (currentState.phase === 'rating') {
          // User is still rating — don't nuke match data or change phase.
          // rating:window_closed or RatingPrompt allDone will handle cleanup.
          store.setTransitionStatus(null);
        } else {
          setTimeout(() => { store.setMatch(null); store.setRoomId(null); }, 500);
          store.setTransitionStatus(null);
          store.setPhase('lobby');
        }
      }
      if (data.currentRound) store.setRound(data.currentRound);
    });

    socket.on('session:round_started', (data: any) => {
      store.setRound(data.roundNumber);
      if (data.totalRounds) store.setTotalRounds(data.totalRounds);
      store.setByeRound(false);
      clearByeTimeout();
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
      clearByeTimeout();
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
    // Host matching events — no participant-visible UI (host communicates verbally)
    socket.on('session:matching_preparing', () => {
      store.setPreparingMatches(true);
    });
    socket.on('session:matching_cancelled', () => {
      store.setPreparingMatches(false);
    });
    socket.on('session:matching_in_progress', () => {
      store.setPreparingMatches(false);
    });
    socket.on('session:matches_confirmed', (data: any) => {
      store.setPreparingMatches(false);
      // Show 3-second "matched" overlay for participants, non-blocking banner for host
      store.setMatchingOverlay({ roomCount: data.matchCount || 0, roundNumber: data.roundNumber || 0 });
      // Auto-clear after 3 seconds
      setTimeout(() => {
        store.setMatchingOverlay(null);
      }, 3000);
    });

    // ── Matching ──
    socket.on('match:assigned', (data: any) => {
      // Only transition to 'matched' phase during an active round — ignore stale
      // match:assigned events that arrive during rating or lobby transitions.
      // NOTE: round_transition is allowed because the server emits match:assigned
      // BEFORE session:status_changed(round_active) when starting a new round.
      const state = useSessionStore.getState();
      if (state.sessionStatus === 'round_rating' || state.sessionStatus === 'completed') return;
      // If user left the current round, block re-entry UNLESS this is a new round
      if (state.leftCurrentRound) {
        const incomingRound = data.roundNumber || 0;
        if (incomingRound <= state.currentRound) return; // Same or older round — block
        // New round — clear the flag and accept
        store.setLeftCurrentRound(false);
      }

      store.setMatchingOverlay(null); // Clear anticipation screen
      store.setByeRound(false);
      clearByeTimeout();
      store.setPartnerDisconnected(false);
      const partners = data.partners || [{ userId: data.partnerId, displayName: data.partnerDisplayName || data.partnerId }];
      store.setMatch({ userId: data.partnerId, displayName: data.partnerDisplayName || data.partnerId }, data.matchId, partners);
      store.setPhase('matched');
      // Store roomId for VideoRoom backup fetch
      if (data.roomId) store.setRoomId(data.roomId);
      // Use inline token if server provided it (instant), otherwise fall back to API fetch
      if (data.token && data.livekitUrl) {
        store.setLiveKitToken(data.token, data.livekitUrl);
        store.setTransitionStatus(null);
      } else {
        store.setTransitionStatus('preparing_match');
        fetchTokenWithRetry(sessionId, data.roomId).then(result => {
          if (result) {
            store.setLiveKitToken(result.token, result.livekitUrl);
          }
          store.setTransitionStatus(null);
        });
      }
    });

    socket.on('match:reassigned', (data: any) => {
      // Reassignment is an explicit action (host or auto) — only block during rating/completed
      const reassignState = useSessionStore.getState();
      if (reassignState.sessionStatus === 'round_rating' || reassignState.sessionStatus === 'completed') return;
      // NOTE: leftCurrentRound does NOT block reassignment — host/system override
      store.setLeftCurrentRound(false); // Clear the flag — user is being put back in a room
      store.setPartnerDisconnected(false);
      store.setMatch({ userId: data.newPartnerId, displayName: data.partnerDisplayName || data.newPartnerId }, data.matchId || null);
      store.setPhase('matched');
      // Use inline token if server provided it, otherwise fall back to API fetch
      if (data.token && data.livekitUrl) {
        store.setLiveKitToken(data.token, data.livekitUrl);
        store.setTransitionStatus(null);
      } else {
        store.setTransitionStatus('preparing_match');
        fetchTokenWithRetry(sessionId, data.roomId).then(result => {
          if (result) {
            store.setLiveKitToken(result.token, result.livekitUrl);
          }
          store.setTransitionStatus(null);
        });
      }
    });

    socket.on('match:partner_disconnected', () => {
      store.setPartnerDisconnected(true);
    });

    socket.on('match:partner_reconnected', () => {
      store.setPartnerDisconnected(false);
    });

    socket.on('match:return_to_lobby', () => {
      // Returned to lobby from breakout room (left conversation or partner left)
      clearTimer(); // Stop round timer — this user's room participation is over
      store.setLiveKitToken(null, null);
      store.setMatch(null);
      store.setRoomId(null);
      store.setByeRound(false);
      store.setPartnerDisconnected(false);
      store.setTransitionStatus(null);
      store.setTimer(0); // Clear displayed timer
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

      // After 15 seconds, if still bye (not reassigned), transition to between_rounds
      // so the user sees "Getting ready for the next round..." instead of sitting idle
      clearByeTimeout();
      byeTimeoutRef.current = setTimeout(() => {
        const s = useSessionStore.getState();
        if (s.isByeRound && s.phase === 'lobby') {
          store.setTransitionStatus('between_rounds');
        }
      }, 15000);
    });

    // ── Ratings ──
    socket.on('rating:window_open', (data: any) => {
      // Accept rating events unless session is fully completed — on mobile (iOS Safari)
      // events can arrive out of order after reconnect, so don't gate on sessionStatus
      const currentState = useSessionStore.getState();
      if (currentState.sessionStatus === 'completed') return;
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
      store.setTransitionStatus(null); // Clear "Round ending — wrapping up" banner
      store.setTimer(data.durationSeconds || 30);
      clearTimer();
      intervalRef.current = setInterval(() => store.tickTimer(), 1000);

      // Early leave: user left breakout mid-round — clear video, prevent re-entry
      if (data.earlyLeave) {
        store.setLiveKitToken(null, null);
        store.setRoomId(null);
        store.setPartnerDisconnected(false);
        store.setLeftCurrentRound(true);
      }

      store.setPhase('rating');

      // ── Fallback safety timer ──
      // If rating:window_closed is missed (network issue, socket drop), auto-return
      // to lobby after rating duration + 30s buffer. Prevents users getting stuck.
      clearRatingFallback();
      const fallbackMs = ((data.durationSeconds || 30) + 30) * 1000;
      ratingFallbackRef.current = setTimeout(() => {
        const currentPhase = useSessionStore.getState().phase;
        if (currentPhase === 'rating') {
          clearTimer();
          store.setLiveKitToken(null, null);
          store.setMatch(null);
          store.setRoomId(null);
          store.setTransitionStatus(null);
          store.setPhase('lobby');
        }
      }, fallbackMs);
    });

    socket.on('rating:window_closed', () => {
      clearTimer();
      clearRatingFallback();
      clearByeTimeout();
      const state = useSessionStore.getState();
      store.setLastRatedRound(state.currentRound);

      // 3-second grace period for in-flight rating submissions
      // Don't nuke match data immediately — let RatingPrompt finish
      setTimeout(() => {
        const current = useSessionStore.getState();
        if (current.phase === 'rating') {
          // Still in rating after grace — force return to lobby
          store.setLiveKitToken(null, null);
          store.setByeRound(false);
          store.setPartnerDisconnected(false);
          store.setMatch(null);
          store.setRoomId(null);
          const isLastRound = current.currentRound >= current.totalRounds && current.totalRounds > 0;
          store.setTransitionStatus(isLastRound ? 'session_ending' : null);
          store.setPhase('lobby');
        }
        // If phase already changed (user finished rating naturally), do nothing
      }, 3000);
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
    socket.on('chat:reaction_update', (data: any) => {
      if (data.messageId && data.reactions) {
        store.updateMessageReaction(data.messageId, data.reactions);
      }
    });

    // ── Sync & errors ──
    socket.on('timer:sync', (data: any) => {
      store.setTimer(data.secondsRemaining);
      // Start a local 1s tick if not already running (smooth countdown for manual rooms)
      if (data.secondsRemaining > 0 && !intervalRef.current) {
        intervalRef.current = setInterval(() => store.tickTimer(), 1000);
      }
    });

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
      // Don't clear LiveKit token here — old token may still be valid and clearing
      // causes a race condition with VideoRoom's backup fetch + 30s timeout.
      // Server will send fresh match:assigned on session:join if needed.
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
      clearRatingFallback();
      clearByeTimeout();
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
