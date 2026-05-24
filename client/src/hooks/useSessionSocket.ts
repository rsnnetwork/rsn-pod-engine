import { useEffect, useRef } from 'react';
import { connectSocket, getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
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
  // Phase 3 (5 May spec compliance) — pre-event plan + future-only repair events.
  'host:event_plan_generated', 'host:event_plan_repaired',
  'chat:message', 'chat:history', 'chat:reaction_update',
  'timer:sync', 'error',
  'cohost:assigned', 'cohost:removed',
  // Phase 8B.1 (8 May spec) — direct permission update so a newly-promoted
  // co-host's UI gains host buttons immediately, without waiting for the
  // 30s session:state re-sync.
  'permissions:updated',
  // Phase G (10 May spec item 11) — host visibility mode change broadcast.
  'host:visibility_changed',
  // Bug 1 (18 May Stefan) — global pin broadcast. Acting hosts pin a
  // participant; everyone's lobby re-renders with that user as the big
  // tile.
  'pin:changed',
  // Bug 26 (19 May Ali) — director's visual tile demote list changed.
  // Every client recomputes which tiles render at participant size.
  'tile:size_changed',
  // Bug 68 (18 May Stefan) — server tells every client in the session
  // room to refetch their snapshot because the roster mutated (cohost
  // assigned/removed, acting-as-host toggled, kick, etc). One event
  // covers all the cases where "everyone must see this change instantly".
  'roster:changed',
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
  // 25 May (F/G) — timestamp of the last manual-breakout timer:sync. While these
  // arrive (every 5s server-side), the breakout owns this client's timer and we
  // drop session-wide round/rating ticks. Self-healing: keyed on the live stream,
  // so it recovers after a refresh without any flag to restore. Window > 5s + margin.
  const lastBreakoutSyncRef = useRef(0);
  const BREAKOUT_OWNERSHIP_MS = 12_000;

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

    // Auto-register participant. Most failures here are idempotent
    // "already registered" — fine. But genuine 4xx/5xx (pod-not-public,
    // session-completed, etc.) should be visible in dev console rather than
    // swallowed silently. The page's own register UI surfaces user-facing
    // errors via React Query mutations elsewhere; this auto-register is a
    // best-effort warmup, so console.warn is the right level of noise.
    api.post(`/sessions/${sessionId}/register`).catch(err => {
      const code = err?.response?.data?.error?.code;
      if (code !== 'SESSION_ALREADY_REGISTERED') {
        console.warn('auto-register failed', { sessionId, code, err });
      }
    });

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
      if (data.testMode !== undefined) store.setTestMode(data.testMode);
      // Phase G (10 May spec item 11) — apply per-user host visibility modes
      // from the authoritative snapshot. Server emits this in session:state.
      if (data.hostVisibilityModes && typeof data.hostVisibilityModes === 'object') {
        store.setHostVisibilityModes(data.hostVisibilityModes);
      }
      // Phase O (12 May spec item 7) — apply server-authoritative host-mute
      // roster. If the local user is in the array, fire the existing
      // hostMuteCommand pathway so their LiveKit audio track is muted
      // even after a reconnect (the pre-fix gap that left Shradha "stuck
      // muted after refresh" was caused by the absence of this replay).
      if (Array.isArray(data.hostMutedUserIds)) {
        store.setHostMutedUserIds(data.hostMutedUserIds);
        const myId = useAuthStore.getState().user?.id;
        if (myId && data.hostMutedUserIds.includes(myId)) {
          store.setHostMuteCommand(true);
        }
      }
    });

    // ── Co-host ──
    socket.on('cohost:assigned', (data: any) => { store.addCohost(data.userId); });
    socket.on('cohost:removed', (data: any) => { store.removeCohost(data.userId); });

    // ── Phase G (10 May spec item 11) — host visibility mode ──
    socket.on('host:visibility_changed', (data: any) => {
      if (data?.userId && data?.mode) store.setHostVisibility(data.userId, data.mode);
    });

    // ── Bug 1 (18 May Stefan) — global pin broadcast ──
    // When ANY acting host pins/unpins someone, the server broadcasts
    // pin:changed to the entire session room. Each viewer's Lobby reads
    // serverPinnedUserId from the store and switches to pinned-mode
    // rendering (big tile + thumb strip) with the named user as the
    // spotlight. The per-viewer local pin (kept in Lobby.tsx useState)
    // remains as a fallback when the global pin is null.
    socket.on('pin:changed', (data: any) => {
      const next = typeof data?.pinnedUserId === 'string' ? data.pinnedUserId : null;
      store.setServerPinnedUserId(next);
    });

    // ── Bug 26 (19 May Ali) — director's visual tile demote list ──
    // Whenever the director resizes a cohost's tile, the server broadcasts
    // the FULL updated list to the session room. Every viewer's Lobby
    // re-renders with the new sizes — demoted cohosts drop the host-tile
    // ring + col-span and become regular participant tiles.
    socket.on('tile:size_changed', (data: any) => {
      const ids = Array.isArray(data?.tileDemotedUserIds) ? data.tileDemotedUserIds : [];
      store.setTileDemotedUserIds(ids);
    });

    // ── Bug 68 (18 May Stefan) — universal "no refresh needed" path ──
    // The server fires roster:changed whenever ANY session-roster mutation
    // happens (cohost assigned/removed, acting-as-host toggled, kick,
    // participant join/leave, etc). Refetching the snapshot pulls down
    // every derived state in one round-trip — cohorts Set, acting-as-host
    // overrides, participant counts, hccParticipants for the HCC drawer.
    // Result: every client's UI converges to the new state within one
    // network round-trip of the mutation, no refresh ever needed.
    socket.on('roster:changed', () => {
      fetchSessionStateSnapshot().catch(() => { /* best-effort */ });
    });

    // Phase 8B.1 (8 May spec) — Stefan #4 + #9: a newly-promoted/demoted
    // co-host's UI must reflect their new role immediately, not after
    // the 30-second session:state safety re-sync. Server sends
    // permissions:updated to that user's userRoom on every cohost
    // change. We trigger a fresh state-snapshot fetch so the local
    // user's effective role + capabilities flip atomically with the
    // cohosts Set.
    socket.on('permissions:updated', () => {
      // Re-pull authoritative state. The snapshot is the canonical
      // source for the cohorts Set + the per-user effective role
      // (computed from session_cohosts on every fetch).
      fetchSessionStateSnapshot().catch(() => { /* best-effort */ });
    });

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
      if (data.isPaused !== undefined) {
        store.setIsPaused(data.isPaused);
        if (data.isPaused) {
          // Pause: stop client-side tick so timer freezes
          clearTimer();
        } else {
          // Resume: restart client-side tick
          if (!intervalRef.current && useSessionStore.getState().timerSeconds > 0) {
            intervalRef.current = setInterval(() => store.tickTimer(), 1000);
          }
        }
      }
      if (data.status === 'completed') { clearTimer(); clearByeTimeout(); store.setLiveKitToken(null, null); store.setMatch(null); store.setRoomId(null); store.setMatchingOverlay(null); store.setRoundDashboard(null); store.setByeRound(false); store.setPartnerDisconnected(false); store.setLeftCurrentRound(false); lastBreakoutSyncRef.current = 0; store.setTransitionStatus('session_ending'); setTimeout(() => { store.setTransitionStatus(null); store.setPhase('complete'); }, 1500); }
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
      // Bug 16 (April 19) — clock-skew-immune: trust server's
      // durationSeconds (relative) over endsAt (absolute). Compute the
      // local endsAt as `clientNow + duration*1000` so display is
      // computed against the SAME clock that ticks. The 10s drift was
      // caused by computing `(serverAbsoluteEndsAt - clientNow)` when
      // host's clock differed from server's by 10s.
      // Also: explicitly reset isPaused so a stale pause flag from a
      // prior round/manual room doesn't carry over and freeze the new
      // round's tick.
      store.setIsPaused(false);
      const duration = typeof data.durationSeconds === 'number'
        ? data.durationSeconds
        : Math.max(0, Math.floor((new Date(data.endsAt).getTime() - Date.now()) / 1000));
      store.setTimer(duration); // explicit reset so stale value (e.g. ended manual room's 8:20) doesn't leak
      store.setTimerEndsAt(new Date(Date.now() + duration * 1000));
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
      // Per-match timer visibility override (Task 14 — bulk manual breakouts)
      store.setBreakoutTimerHidden(data.timerVisibility === 'hidden');
      // 25 May (F/G) — an algorithm-round match is NOT a manual breakout; hand the
      // timer back to the session round timer (timer:sync) for this user now.
      lastBreakoutSyncRef.current = 0;
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
      // Per-match timer visibility override (Task 14 — bulk manual breakouts)
      store.setBreakoutTimerHidden(data.timerVisibility === 'hidden');
      // 25 May (F/G) — manual breakouts arrive as match:reassigned with isManual,
      // immediately followed by the room's first 'breakout' timer:sync, which the
      // recency gate picks up. Algorithm re-pairs omit isManual → no breakout ticks
      // → the session timer keeps ownership. No explicit flag needed here.
      store.setMatch({ userId: data.newPartnerId, displayName: data.partnerDisplayName || data.newPartnerId }, data.matchId || null);
      // Phase C1 (10 May spec) — capture the LiveKit room id for the new
      // breakout. Pre-fix, only match:assigned called setRoomId, so a
      // reassigned user kept the old roomId in store and the chat filter
      // (which now keys on currentRoomId) silently dropped messages from
      // the actual new room.
      if (data.roomId) store.setRoomId(data.roomId);
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
      store.setBreakoutTimerHidden(false); // Reset per-match visibility override
      lastBreakoutSyncRef.current = 0; // 25 May (F/G) — left the breakout; session timer owns again
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
      // 25 May (F/G) — rating opens AFTER a breakout ends (incl. host End-all-rooms,
      // which routes participants straight to rating). Release breakout ownership so
      // the session-level rating countdown (segmentType 'round_rating') shows at once.
      lastBreakoutSyncRef.current = 0;
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

    // ── Phase 3 (5 May spec) — pre-event plan + future-only repair toasts ──
    // Server emits these when generateSessionSchedule completes at event start
    // and when repairFutureRounds runs after a late-joiner / leaver. Wired at
    // the central socket hub so any client viewing a session sees the toast.
    socket.on('host:event_plan_generated', (data: any) => {
      const toast = useToastStore.getState().addToast;
      const rc = data?.roundCount ?? 0;
      const tp = data?.totalPairs ?? 0;
      toast(`Event plan ready — ${rc} ${rc === 1 ? 'round' : 'rounds'}, ${tp} ${tp === 1 ? 'pair' : 'pairs'}`, 'success');
      // Also store the headline numbers so the host UI can show them persistently.
      store.setEventPlanSummary?.({ roundCount: rc, totalPairs: tp });
    });

    socket.on('host:event_plan_repaired', (data: any) => {
      const toast = useToastStore.getState().addToast;
      const reasonText: Record<string, string> = {
        late_joiner: 'new participant joined',
        left: 'participant left',
        host_request: 'manual update',
      };
      const reason = reasonText[data?.reason] || 'plan updated';
      const rounds: number[] = data?.regeneratedRounds || [];
      if (rounds.length === 0) return; // nothing changed; skip toast
      // Bug 18 (18 May Stefan) — sync the headline summary so the host
      // sees the new round/pair totals in the EventPlan strip, not just
      // the per-round badges. Pre-fix only host:event_plan_generated
      // updated this store value, so post-repair the strip's "Plan: X
      // rounds · Y pairs" kept showing the original Start-of-event
      // numbers even when the badges underneath reflected the new plan.
      const rc = typeof data?.roundCount === 'number' ? data.roundCount : null;
      const tp = typeof data?.totalPairs === 'number' ? data.totalPairs : null;
      if (rc !== null && tp !== null) {
        store.setEventPlanSummary?.({ roundCount: rc, totalPairs: tp });
      }
      // Bug 27 (19 May Ali) — Bug 22 closed the DB persistence + plan-strip
      // gap but left `totalRounds` in the client store stale between
      // "Another Round" click and the next round_started event. Every
      // surface that reads totalRounds ("Round N of M" in main room, host
      // controls, breakout rooms, rating prompt last-round logic) stuck
      // on the pre-bump number for the rating-window duration. Pushing
      // the fresh count here closes that window — every UI updates the
      // moment the bump broadcast lands.
      if (rc !== null) {
        store.setTotalRounds(rc);
      }
      // Bug 28 (19 May Ali + Stefan) — track bonus-round count so the
      // header shows a "Bonus" pill on any round past the originally-
      // configured count. Server sends the cumulative total in every
      // event_plan_repaired emit with reason='host_request' (the
      // Another Round path); late-joiner / left repairs leave it
      // untouched (the field stays undefined for those, so we skip).
      if (typeof data?.bonusRoundsAdded === 'number') {
        store.setBonusRoundsAdded(data.bonusRoundsAdded);
      }
      const range = rounds.length === 1
        ? `round ${rounds[0]}`
        : `rounds ${rounds[0]}–${rounds[rounds.length - 1]}`;
      toast(`Plan updated for ${range} (${reason})`, 'info');
    });

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
      // Bug 20 (April 19) — clock-skew-immune per-room manual timer.
      // Server sends `roomSecondsRemaining` (relative) per room. Rebase
      // the absolute `roomEndsAt` to the CLIENT's clock so the host
      // dashboard's per-room countdown matches what the participant sees,
      // even if the host's machine clock differs from the server's.
      // This is the same fix shape as Bug 16 (algorithm round timer).
      const nowMs = Date.now();
      const rebased = {
        ...data,
        rooms: Array.isArray(data.rooms)
          ? data.rooms.map((r: any) => {
              if (typeof r.roomSecondsRemaining === 'number' && r.roomSecondsRemaining > 0) {
                return {
                  ...r,
                  roomEndsAt: new Date(nowMs + r.roomSecondsRemaining * 1000).toISOString(),
                };
              }
              return r;
            })
          : data.rooms,
      };
      store.setRoundDashboard(rebased);
    });

    socket.on('host:room_status_update', (data: any) => {
      store.updateRoomStatus(data.matchId, data.status, data.participants);
    });

    // ── Chat ──
    socket.on('chat:message', (data: any) => store.addChatMessage(data));
    socket.on('chat:history', (data: any) => {
      if (!data.messages || !Array.isArray(data.messages)) return;
      // Bug 15 (13 May live test) — an empty server reply must not wipe the
      // local array. Pre-fix, a race during round transitions could ship
      // an empty history back and erase the messages the user had just
      // exchanged. Only replace when the server's authoritative reply is
      // non-empty; an empty reply means "I have no extra history for you
      // right now", not "discard what you have".
      if (data.messages.length === 0) return;
      store.setChatMessages(data.messages);
    });
    socket.on('chat:reaction_update', (data: any) => {
      if (data.messageId && data.reactions) {
        store.updateMessageReaction(data.messageId, data.reactions);
      }
    });

    // ── Sync & errors ──
    socket.on('timer:sync', (data: any) => {
      // Bug 17 (April 19) — REAL root cause of the persistent "host pause
      // doesn't actually pause" bug. The previous guard `if (phase === 'lobby'
      // || phase === 'complete') return;` dropped EVERY timer:sync — including
      // the pause snapshot — for the host, because the host stays in 'lobby'
      // phase throughout the round (they don't enter breakouts). Their local
      // 1s tick interval kept running while the server thought everything
      // was synced. Result: host display kept ticking during pause; on resume
      // the new endsAt arrived but the host's tick had already advanced.
      //
      // New rule: pause/resume snapshots are ALWAYS processed (every client
      // needs to know). For non-pause sync, only skip after a true terminal
      // 'complete' phase OR before any round has started (currentRound===0
      // AND phase==='lobby'). Host viewing the dashboard during a round has
      // currentRound > 0, so accepts timer:sync.
      const state = useSessionStore.getState();
      const isPauseSnapshot = data.paused === true || data.paused === false;

      // 25 May (F/G) — timer SCOPE, self-healing. Manual breakout rooms emit a
      // per-user timer:sync tagged segmentType 'breakout' every 5s (a server-side
      // interval that keeps running across a participant's refresh). Round/rating
      // timers are broadcast to the whole sessionRoom tagged with a session status.
      // A user in a breakout is also in the sessionRoom, so the session broadcast
      // would otherwise clobber the per-room countdown (the 158↔43 / 4:23↔8:23
      // flicker). While breakout ticks are actively arriving, the breakout owns
      // this client's timer — drop session-level ticks (incl. their pause snapshot).
      // Keyed on the live stream, NOT a flag, so it recovers automatically after
      // a refresh. Explicit resets (below) hand the timer back the instant a user
      // leaves the breakout (rating opens / return to lobby / new round).
      const nowMs = Date.now();
      if (data.segmentType === 'breakout') {
        lastBreakoutSyncRef.current = nowMs;
      } else if (nowMs - lastBreakoutSyncRef.current < BREAKOUT_OWNERSHIP_MS) {
        return;
      }

      if (!isPauseSnapshot) {
        if (state.phase === 'complete') return;
        if (state.currentRound === 0 && state.phase === 'lobby') return;
      }

      // Bug 8.5 — pause path: server sends endsAt:null + paused:true with
      // an authoritative secondsRemaining snapshot. Freeze display at the
      // snapshot, clear endsAt so the recompute path stops auto-decrementing.
      if (data.paused === true) {
        clearTimer();
        store.setIsPaused(true);
        store.setTimerEndsAt(null);
        store.setTimer(data.secondsRemaining);
        return;
      }
      if (data.paused === false) store.setIsPaused(false);

      // Bug 16 (April 19) — clock-skew immune. Use server's
      // secondsRemaining as the source of truth (relative time = no
      // clock skew). Compute local endsAt = clientNow + secondsRemaining
      // *1000 so subsequent ticks recompute against the SAME clock that
      // ticks. Drops the 10s "host pause/resume drift" caused by clock
      // differences between host machine and server.
      if (typeof data.secondsRemaining === 'number') {
        store.setTimerEndsAt(new Date(Date.now() + data.secondsRemaining * 1000));
      } else if (data.endsAt) {
        // Fallback if no secondsRemaining (older server payload during
        // rolling deploys) — best-effort using absolute timestamp.
        const remaining = Math.max(0, Math.floor((new Date(data.endsAt).getTime() - Date.now()) / 1000));
        store.setTimerEndsAt(new Date(Date.now() + remaining * 1000));
      }

      // Always clear existing interval then start fresh — prevents ghost timer overlap.
      // The interval triggers tickTimer() which RECOMPUTES from endsAt (no decrement).
      if (data.secondsRemaining > 0) {
        clearTimer();
        intervalRef.current = setInterval(() => store.tickTimer(), 1000);
      }
    });

    socket.on('error', (data: any) => {
      // Phase 5A (5 May spec) — Stefan #14: surface socket errors as toasts
      // with code-specific friendly text instead of just a transient banner.
      // Codes that map to known user-actionable failures get tailored copy;
      // anything unrecognised falls through to the generic message.
      const code = data?.code || '';
      const rawMsg = data?.message || 'An error occurred';
      const FRIENDLY: Record<string, { msg: string; severity: 'error' | 'info' }> = {
        UNAUTHORIZED: { msg: 'You need to sign in again.', severity: 'error' },
        VALIDATION_ERROR: { msg: rawMsg, severity: 'info' },
        INVALID_STATE: { msg: rawMsg, severity: 'info' },
        NOT_ENOUGH_PARTICIPANTS: { msg: 'Not enough participants to start matching yet.', severity: 'info' },
        INSUFFICIENT_PARTICIPANTS: { msg: rawMsg, severity: 'info' },
        NO_ELIGIBLE_PAIRS: { msg: 'Everyone has already been matched. End the event or wait for new participants.', severity: 'info' },
        GENERATE_FAILED: { msg: 'Could not generate matches. Try again.', severity: 'error' },
        REGENERATE_FAILED: { msg: 'Re-match failed. Try again.', severity: 'error' },
        // 23 May (Stefan live test) — Re-match couldn't produce a different
        // no-repeat arrangement; show the server's reason as an info toast so
        // the button never looks dead.
        REMATCH_NO_ALTERNATIVE: { msg: rawMsg, severity: 'info' },
        ROOM_CREATION_FAILED: { msg: 'Could not create breakout room. Try again.', severity: 'error' },
        MATCH_CREATION_FAILED: { msg: 'Could not assign participants to the room. Try again.', severity: 'error' },
        // 23 May — surface the server's detailed "X and Y are already in another
        // room — use Swap" guidance instead of a generic line (raised by manual
        // breakout-room creation when a participant is already placed).
        PARTICIPANT_ALREADY_MATCHED: { msg: rawMsg, severity: 'info' },
        REMOVE_FAILED: { msg: 'Could not remove that participant. Try again.', severity: 'error' },
        DM_SEND_FAILED: { msg: 'Message could not be sent. Try again.', severity: 'error' },
        DM_REACT_FAILED: { msg: 'Reaction could not be added. Try again.', severity: 'info' },
      };
      const entry = FRIENDLY[code] || { msg: rawMsg, severity: 'error' as const };
      // Toast for visibility, plus banner for persistence on critical issues.
      useToastStore.getState().addToast(entry.msg, entry.severity);
      if (entry.severity === 'error') {
        store.setError(entry.msg);
        setTimeout(() => {
          const current = useSessionStore.getState().error;
          if (current === entry.msg) store.setError(null);
        }, 5000);
      }
    });

    // T0-3 — authoritative state resync via REST. Called on mount and on
    // every successful reconnect. Replaces the broadcast-only model where
    // a client that missed `session:status_changed` (e.g. reconnected
    // mid-transition) stayed out of sync until the next manual refresh.
    // Snapshot is dispatched atomically via `applyFullState`, so the round
    // / timer / participants / cohosts all flip together (no UI tearing).
    const fetchSessionStateSnapshot = async (): Promise<void> => {
      try {
        const res = await api.get(`/sessions/${sessionId}/state`);
        if (res?.data?.success && res.data.data) {
          store.applyFullState(res.data.data);
        }
      } catch (err) {
        // Snapshot fetch failure is non-fatal — socket events still flow.
        // Drop a debug log so we can spot patterns in Sentry breadcrumbs.
        // eslint-disable-next-line no-console
        console.debug('[useSessionSocket] state snapshot fetch failed:', err);
      }
    };
    // Fire once on mount (after small delay to let auth settle).
    const initialSnapshotTimer = setTimeout(() => {
      fetchSessionStateSnapshot();
    }, 250);

    // Phase 7B.1 (7 May spec) — periodic backend re-sync.
    // Stefan #4: socket events are the primary state-change channel, but
    // a missed event (network blip, server restart, race) can leave the
    // client showing a stale state forever. Every 30s, fetch the
    // authoritative snapshot from the backend; if anything differs from
    // local, server wins (applyFullState reconciles atomically). This
    // is a safety net BEHIND socket events, not a replacement.
    const PERIODIC_RESYNC_MS = 30_000;
    const periodicResyncInterval = setInterval(() => {
      fetchSessionStateSnapshot();
    }, PERIODIC_RESYNC_MS);

    // ── Reconnection ──
    const onReconnect = () => {
      store.setReconnecting(false);
      store.setConnectionStatus('connected');
      store.setError(null);
      // Don't clear LiveKit token here — old token may still be valid and clearing
      // causes a race condition with VideoRoom's backup fetch + 30s timeout.
      // Server will send fresh match:assigned on session:join if needed.
      socket.emit('session:join', { sessionId });
      // T0-3 — refetch authoritative state on every reconnect to recover
      // anything we might have missed during the disconnect window.
      fetchSessionStateSnapshot();
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

    // #16 (24 May, Ali — pre-event hardening) — when the user returns from the
    // background (phone call, tab switch, screen lock, app switch) the OS may
    // have throttled the heartbeat or dropped the socket, leaving the server
    // thinking they're gone. The moment they're foregrounded, re-register
    // presence so the server (and the matcher) counts them as present again —
    // no button, no refresh. Debounced so a burst of focus/visibility flips
    // fires once. Uses the same session:join the reconnect handler uses.
    let resyncDebounce: ReturnType<typeof setTimeout> | null = null;
    const resyncPresenceOnReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (resyncDebounce) return;
      resyncDebounce = setTimeout(() => { resyncDebounce = null; }, 2000);
      // 25 May (A) — on return, RE-REGISTER via session:join so a backgrounded /
      // dropped user is counted by the matcher again (exactly what a manual
      // refresh does). The earlier heartbeat-only attempt did NOT re-register and
      // left present people unmatched until they refreshed. This is safe now:
      // skips are recorded server-side (#6 — no rating re-prompt), and the
      // reconnect-reset only fires for users with no active match, so an
      // in-breakout user is never flipped to the main room (#B).
      if (!socket.connected) socket.connect();
      socket.emit('session:join', { sessionId });
      socket.emit('presence:heartbeat', { sessionId });
    };
    document.addEventListener('visibilitychange', resyncPresenceOnReturn);
    window.addEventListener('focus', resyncPresenceOnReturn);
    window.addEventListener('online', resyncPresenceOnReturn);

    return () => {
      if (resyncDebounce) clearTimeout(resyncDebounce);
      document.removeEventListener('visibilitychange', resyncPresenceOnReturn);
      window.removeEventListener('focus', resyncPresenceOnReturn);
      window.removeEventListener('online', resyncPresenceOnReturn);
      clearTimer();
      clearRatingFallback();
      clearByeTimeout();
      clearInterval(heartbeatInterval);
      clearTimeout(initialSnapshotTimer);
      clearInterval(periodicResyncInterval);

      // Remove ALL socket event listeners we attached
      for (const ev of SOCKET_EVENTS) socket.off(ev);
      socket.off('connect', joinSession);
      socket.io.off('reconnect', onReconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect_failed', onReconnectFailed);

      // Leave the session room only — do NOT disconnect the global
      // socket. Bug 32 (19 May Ali): the socket is now an app-lifetime
      // connection owned by App.tsx so realtime works on every page,
      // not just the live event. Disconnecting here would kill
      // notifications + pod / session list updates on every page the
      // user navigates to after leaving an event.
      socket.emit('session:leave', { sessionId });

      // Allow re-initialization if this effect re-runs
      initializedRef.current = null;
    };
  }, [sessionId]);
}
