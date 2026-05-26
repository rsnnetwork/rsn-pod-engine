import { create } from 'zustand';
import { useMemo } from 'react';

interface Participant {
  userId: string;
  displayName?: string;
}

interface MatchPartner {
  userId: string;
  displayName?: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  timestamp: string;
  scope: 'lobby' | 'room';
  isHost: boolean;
  reactions?: Record<string, string[]>;
  roomId?: string;
}

type SessionPhase = 'lobby' | 'matched' | 'rating' | 'complete';
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type TransitionStatus =
  | null
  | 'starting_session'
  | 'preparing_match'
  | 'round_ending'
  | 'between_rounds'
  | 'session_ending'
  | 'evicted';
type SessionStatus = 'scheduled' | 'lobby_open' | 'round_active' | 'round_rating' | 'round_transition' | 'closing_lobby' | 'completed' | 'cancelled';

interface SessionLiveState {
  phase: SessionPhase;
  connectionStatus: ConnectionStatus;
  transitionStatus: TransitionStatus;
  sessionStatus: SessionStatus;
  hostInLobby: boolean;
  hostUserId: string | null;
  // Bug I (15 May Ali) — TRUE once applyFullState has run at least once
  // for this session. UIs that decide things based on an absent override
  // (e.g. the "Join as host / participant" banner that gates content
  // for admins who haven't picked yet) should wait until snapshot hydration
  // completes before rendering, otherwise refresh flickers the banner on
  // for a frame while the snapshot is in-flight.
  sessionStateLoaded: boolean;
  // Bug 1 (18 May Stefan) — server-broadcast pin. When non-null, every
  // viewer's lobby renders this userId as the big tile. Hosts/cohosts
  // write to it via host:set_pin; participants read it. Per-viewer local
  // pin (Lobby's pinnedSid useState) still exists but is overridden by
  // this value whenever it's set.
  serverPinnedUserId: string | null;
  // Bug 26 (19 May Ali) — director's visual tile demote list. User IDs
  // here are cohosts whose lobby tile renders at participant size with
  // no host-ring. Privileges unchanged. Updated live via
  // `tile:size_changed` socket event; snapshot bundles the current set
  // so refreshes don't flicker through a host-tile state first.
  tileDemotedUserIds: string[];
  // Bug 68 (18 May Stefan) — HCC participants list bundled on the
  // session snapshot. The HCC drawer prefers this when the live
  // host:round_dashboard event hasn't arrived yet (e.g. cohost was just
  // promoted and opens HCC before the dashboard tick lands), so the
  // drawer never renders empty for a freshly-promoted user.
  hccParticipants: Array<{
    userId: string;
    displayName: string;
    email: string | null;
    role: 'host' | 'cohost' | 'participant';
    globalRole?: 'user' | 'admin' | 'super_admin';
    state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
    currentMatchId: string | null;
    currentRoomId: string | null;
    joinedAt: string;
  }>;
  totalRounds: number;
  // Bug 28 (19 May Ali + Stefan) — count of "Another Round" bumps for
  // this event. Drives the "Bonus" badge on the round header for any
  // round beyond (totalRounds - bonusRoundsAdded). Default 0.
  bonusRoundsAdded: number;
  participants: Participant[];
  // F3 (21 May Ali) — REALTIME in-room presence, sourced from LiveKit's
  // useParticipants() inside the lobby <LiveKitRoom>. The Zustand
  // `participants` array drifts across viewers when socket fan-out misses
  // a client (Aug 21 morning test: 5 actual, viewer counts 5/4/3 — even
  // after the M1 auto-LEFT removal, each browser had a different cached
  // roster because participant:joined emits don't always reach every
  // tab). LiveKit's room state is the only signal every viewer subscribes
  // to the same server-of-truth for — so it becomes our authoritative
  // "who is in the main room right now" list. Empty when no LiveKit room
  // is mounted (pre-event waiting room, text-only fallback) — in that
  // case the existing socket-fed `participants` array is used as-is.
  liveRoomParticipants: Array<{ userId: string; displayName: string }>;
  currentMatch: MatchPartner | null;
  currentPartners: MatchPartner[];  // All partners (1 for pair, 2 for trio)
  currentMatchId: string | null;
  timerSeconds: number;
  currentRound: number;
  broadcasts: string[];
  error: string | null;
  isReconnecting: boolean;
  isByeRound: boolean;
  liveKitToken: string | null;
  livekitUrl: string | null;
  currentRoomId: string | null;
  lobbyToken: string | null;
  lobbyUrl: string | null;
  lobbyRoomId: string | null;
  timerVisibility: 'hidden' | 'always_visible' | 'last_10s' | 'last_30s' | 'last_60s' | 'last_120s';
  // Per-match override from bulk manual breakouts (Task 14). When true, countdown
  // is completely hidden for THIS breakout room regardless of session-level setting.
  breakoutTimerHidden: boolean;
  matchPreview: {
    roundNumber: number;
    matches: { participantA: { userId: string; displayName: string }; participantB: { userId: string; displayName: string }; participantC?: { userId: string; displayName: string }; isTrio?: boolean; metBefore?: boolean; timesMet?: number }[];
    byeParticipants: { userId: string; displayName: string }[];
    warnings?: string[];
    // 26 May (#9-UI) — true when the engine had to reuse already-met pairs.
    // Drives persistent banner + toast in the host preview UI.
    usedRepeats?: boolean;
  } | null;
  hostMuteCommand: boolean | null; // null=no command, true=muted by host, false=unmuted by host
  partnerDisconnected: boolean;
  roundDashboard: {
    roundNumber: number;
    rooms: {
      matchId: string;
      roomId: string;
      status: string;
      participants: { userId: string; displayName: string; isConnected: boolean }[];
      isTrio: boolean;
      isManual?: boolean;
      // Bug 18 (April 19) — per-manual-room timer. null for algorithm
      // rooms (they share the session-level round timer).
      roomEndsAt?: string | null;
      roomStartedAt?: string | null;
    }[];
    byeParticipants: { userId: string; displayName: string }[];
    reassignmentInProgress: boolean;
    eligibleMainRoomCount?: number;
    // Algorithm round endsAt — top-level. null when no algorithm round
    // is active (e.g. between rounds, or only manual breakouts running).
    timerEndsAt?: string | null;
    // Server-RELATIVE round seconds remaining (clock-skew-immune). The host
    // dashboard seeds a local countdown from this instead of subtracting the
    // host clock from the absolute timerEndsAt (which inflated under skew).
    timerSecondsRemaining?: number | null;
    // Phase 7C.1 (7 May spec) — Host Control Center backing data.
    // Optional for forward-compat with reconnect/older payloads.
    participants?: Array<{
      userId: string;
      displayName: string;
      email: string | null;
      role: 'host' | 'cohost' | 'participant';
      // Bug J (15 May Ali) — global platform role used by HCC to gate
      // Make / Remove co-host and Kick. `globalRole` is OPTIONAL so older
      // payloads (pre-Bug-J server) still parse; the client treats a
      // missing value as 'user' (i.e. fully manageable).
      globalRole?: 'user' | 'admin' | 'super_admin';
      state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
      currentMatchId: string | null;
      currentRoomId: string | null;
      joinedAt: string;
    }>;
  } | null;
  chatMessages: ChatMessage[];
  unreadChatCount: number;
  chatOpen: boolean;
  matchingOverlay: { roomCount: number; roundNumber: number } | null;
  preparingMatches: boolean;
  // Phase 3 (5 May spec) — pre-event plan headline numbers, populated by the
  // host:event_plan_generated socket event. Used by HostControls to show a
  // persistent "Plan: 5 rounds, 15 pairs" badge after the host clicks Start.
  eventPlanSummary: { roundCount: number; totalPairs: number } | null;
  // Phase 5B (5 May spec) — test-mode flag from session state snapshot.
  // Server detects when 2+ participants share email-username root with the
  // host (heuristic) or honours an explicit session.config.testMode override.
  testMode: boolean;
  lobbyDensity: 'compact' | 'normal' | 'spacious';
  cohosts: Set<string>;
  /**
   * Phase G (10 May spec item 11) — host visibility mode per host/co-host.
   * Map of userId → 'big_speaker' | 'normal' | 'producer' | 'hidden'.
   * Absent users default to 'normal'. Drives lobby/video tile rendering:
   * 'hidden' users are not shown anywhere; 'producer' users are not shown
   * in video tiles; 'big_speaker' users are pinned big when present.
   */
  hostVisibilityModes: Record<string, 'big_speaker' | 'normal' | 'producer' | 'hidden'>;
  /**
   * Phase M (12 May spec item 1) — acting-as-host overrides per user.
   * Map of userId → boolean. TRUE = opted-in to host, FALSE = opted-out
   * to participant. Absent users follow the role default. LiveSessionPage
   * factors this into `isHost` for the local user only.
   */
  actingAsHostOverrides: Record<string, boolean>;
  /**
   * Phase O (12 May spec item 7) — server-authoritative host-muted state.
   * Set of userIds whose host_muted=TRUE on session_participants. The
   * local user checks if their own id is in the set on snapshot apply
   * and mirrors the mute on their LiveKit audio track. Server is the
   * single source of truth — self-unmute does not clear this.
   */
  hostMutedUserIds: Set<string>;
  leftCurrentRound: boolean;
  lastRatedRound: number;
  // #2 (26 May, live-test-2) — matchIds the user has already FULLY handled
  // (rated or skipped every partner of that match). The rating:window_open
  // handler suppresses re-prompting a match in this set so a re-emit during
  // re-match churn can't re-open a form for a match the user already finished
  // (server 409s the duplicate POST, but the user still saw "rate again").
  // Keyed by matchId so a genuinely NEW match (new matchId) still shows the form.
  ratedMatchIds: Set<string>;
  isPaused: boolean;
  // Bug 10 (April 19) — Meet/Zoom-style reactions anchored to the
  // participant's tile. Replaces the floating-animation-only UX so
  // people can actually see WHO reacted.
  tileReactions: Record<string, { emoji: string; displayName: string; expiresAt: number }>;

  // Phase 5 — monotonic seq for the versioned state:snapshot channel.
  // Initialized to -1 so the first snapshot (seq ≥ 0) is always accepted.
  snapshotSeq: number;

  setPhase: (phase: SessionPhase) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setTransitionStatus: (status: TransitionStatus) => void;
  setSessionStatus: (status: SessionStatus) => void;
  setHostInLobby: (inLobby: boolean) => void;
  setHostUserId: (hostUserId: string | null) => void;
  setTotalRounds: (total: number) => void;
  // Bug 28 (19 May Ali + Stefan) — replace the bonus-round count.
  setBonusRoundsAdded: (count: number) => void;
  setParticipants: (p: Participant[]) => void;
  addParticipant: (p: Participant) => void;
  removeParticipant: (userId: string) => void;
  // F3 (21 May Ali) — push LiveKit room membership into the store from
  // LiveKitPresenceSync (mounted inside <LiveKitRoom>). Identity = userId
  // (server token generator uses userId as the LiveKit identity, see
  // Lobby.tsx:122 which already relies on this invariant).
  setLiveRoomParticipants: (list: Array<{ userId: string; displayName: string }>) => void;
  setMatch: (m: MatchPartner | null, matchId?: string | null, partners?: MatchPartner[]) => void;
  // Bug 8.5 (April 19) — Timer is now derived from server's authoritative
  // `endsAt` timestamp, NOT from a local 1s decrement. Local decrement was
  // fragile to tab throttling, browser sleep, clock skew, and missed syncs
  // during reconnect — easily producing >60s drift between host and
  // participants. Now: server sends `endsAt`; client recomputes
  // `timerSeconds = max(0, ceil((endsAt - now) / 1000))` on every tick.
  // The 1s "tick" interval still runs, but it just triggers a recompute
  // — never decrements. Result: drift bounded by clock skew (few seconds)
  // regardless of how many ticks the client missed.
  timerEndsAt: Date | null;
  setTimer: (s: number) => void;
  setTimerEndsAt: (endsAt: Date | null) => void;
  tickTimer: () => void;
  setRound: (r: number) => void;
  addBroadcast: (msg: string) => void;
  setError: (err: string | null) => void;
  setReconnecting: (v: boolean) => void;
  setByeRound: (v: boolean) => void;
  setLiveKitToken: (token: string | null, url?: string | null) => void;
  setRoomId: (roomId: string | null) => void;
  setLobbyToken: (token: string | null, url?: string | null, roomId?: string | null) => void;
  setTimerVisibility: (v: 'hidden' | 'always_visible' | 'last_10s' | 'last_30s' | 'last_60s' | 'last_120s') => void;
  setBreakoutTimerHidden: (v: boolean) => void;
  setMatchPreview: (preview: SessionLiveState['matchPreview']) => void;
  setEventPlanSummary: (summary: SessionLiveState['eventPlanSummary']) => void;
  setTestMode: (testMode: boolean) => void;
  setHostMuteCommand: (muted: boolean | null) => void;
  setPartnerDisconnected: (v: boolean) => void;
  setRoundDashboard: (data: SessionLiveState['roundDashboard']) => void;
  updateRoomStatus: (matchId: string, status: string, participants: { userId: string; displayName: string; isConnected: boolean }[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  updateMessageReaction: (messageId: string, reactions: Record<string, string[]>) => void;
  clearChatMessages: () => void;
  setChatOpen: (open: boolean) => void;
  resetUnreadChat: () => void;
  setMatchingOverlay: (data: { roomCount: number; roundNumber: number } | null) => void;
  setPreparingMatches: (preparing: boolean) => void;
  setLobbyDensity: (d: 'compact' | 'normal' | 'spacious') => void;
  setCohosts: (userIds: string[]) => void;
  addCohost: (userId: string) => void;
  removeCohost: (userId: string) => void;
  setHostVisibility: (userId: string, mode: 'big_speaker' | 'normal' | 'producer' | 'hidden') => void;
  setHostVisibilityModes: (modes: Record<string, 'big_speaker' | 'normal' | 'producer' | 'hidden'>) => void;
  setActingAsHostOverrides: (overrides: Record<string, boolean>) => void;
  setHostMutedUserIds: (ids: string[]) => void;
  // Bug 1 (18 May Stefan) — set/clear the server-broadcast pin.
  setServerPinnedUserId: (userId: string | null) => void;
  // Bug 26 (19 May Ali) — replace the director's tile demote list.
  setTileDemotedUserIds: (ids: string[]) => void;
  setLeftCurrentRound: (v: boolean) => void;
  setLastRatedRound: (r: number) => void;
  // #2 (26 May) — mark a match fully handled so it's never re-prompted.
  addRatedMatchId: (matchId: string) => void;
  setIsPaused: (v: boolean) => void;
  // Bug 10 — reaction anchored to a participant tile for ~8s.
  setTileReaction: (userId: string, emoji: string, displayName: string) => void;
  clearTileReaction: (userId: string) => void;

  // T0-3 — atomic state-snapshot application. Used by useSessionSocket on
  // mount and reconnect to bring the store in line with the server's
  // authoritative state in one shot. Prevents the partial-update tearing
  // that broadcast-based recovery used to produce.
  applyFullState: (snapshot: SessionStateSnapshot) => void;

  // Phase 5 — seq-guarded consumer of the versioned state:snapshot push.
  // Out-of-order or replayed snapshots are dropped (seq-guard). Does NOT
  // replace applyFullState or touch fields that snapshot doesn't carry.
  applyStateSnapshot: (snap: { seq: number; participants: Array<{ userId: string; displayName?: string }> }) => void;

  reset: () => void;
}

/** Mirror of server's session-state-snapshot.service.ts SessionStateSnapshot. */
export interface SessionStateSnapshot {
  sessionId: string;
  sessionStatus: SessionStatus;
  currentRound: number;
  totalRounds: number;
  isPaused: boolean;
  timerEndsAt: string | null;
  pausedTimeRemainingMs: number | null;
  pendingRoundNumber: number | null;
  hostUserId: string | null;
  cohosts: string[];
  connectedParticipants: Array<{ userId: string; displayName: string }>;
  hostInLobby: boolean;
  /** T1-4 — three canonical participant counts (host excluded from headline). */
  participantCounts: {
    connected: number;
    registered: number;
    active: number;
    hostConnected: boolean;
    ghostFiltered: boolean;
  };
  timerVisibility: string;
  /** Phase G — host/cohost visibility modes from snapshot. */
  hostVisibilityModes?: Record<string, string>;
  /** Phase M — acting-as-host overrides from snapshot. */
  actingAsHostOverrides?: Record<string, boolean>;
  /** Phase O — server-authoritative host-muted user IDs from snapshot. */
  hostMutedUserIds?: string[];
}

export const useSessionStore = create<SessionLiveState>((set) => ({
  phase: 'lobby',
  connectionStatus: 'connecting',
  transitionStatus: null,
  sessionStatus: 'scheduled',
  hostInLobby: false, hostUserId: null,
  sessionStateLoaded: false,
  serverPinnedUserId: null,
  tileDemotedUserIds: [],
  hccParticipants: [],
  totalRounds: 5,
  bonusRoundsAdded: 0,
  participants: [],
  liveRoomParticipants: [],
  currentMatch: null,
  currentPartners: [],
  currentMatchId: null,
  timerSeconds: 0,
  timerEndsAt: null,
  currentRound: 0,
  broadcasts: [],
  error: null,
  isReconnecting: false,
  isByeRound: false,
  liveKitToken: null,
  livekitUrl: null,
  currentRoomId: null,
  lobbyToken: null,
  lobbyUrl: null,
  lobbyRoomId: null,
  timerVisibility: 'always_visible',
  breakoutTimerHidden: false,
  matchPreview: null,
  eventPlanSummary: null,
  testMode: false,
  hostMuteCommand: null,
  partnerDisconnected: false,
  roundDashboard: null,
  chatMessages: [],
  unreadChatCount: 0,
  chatOpen: true,
  matchingOverlay: null,
  preparingMatches: false,
  lobbyDensity: 'normal' as const,
  cohosts: new Set<string>(),
  hostVisibilityModes: {},
  actingAsHostOverrides: {},
  hostMutedUserIds: new Set<string>(),
  leftCurrentRound: false,
  lastRatedRound: 0,
  ratedMatchIds: new Set<string>(),
  isPaused: false,
  tileReactions: {},
  snapshotSeq: -1,

  setPhase: (phase) => set({ phase }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setTransitionStatus: (transitionStatus) => set({ transitionStatus }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setHostInLobby: (hostInLobby) => set({ hostInLobby }),
  setHostUserId: (hostUserId) => set({ hostUserId }),
  setTotalRounds: (totalRounds) => set({ totalRounds }),
  setBonusRoundsAdded: (bonusRoundsAdded) => set({ bonusRoundsAdded: typeof bonusRoundsAdded === 'number' && bonusRoundsAdded >= 0 ? bonusRoundsAdded : 0 }),
  setParticipants: (participants) => set({ participants }),
  addParticipant: (p) => set((s) => ({
    participants: s.participants.some(x => x.userId === p.userId) ? s.participants : [...s.participants, p],
  })),
  removeParticipant: (userId) => set((s) => ({
    participants: s.participants.filter(x => x.userId !== userId),
  })),
  setLiveRoomParticipants: (list) => set({ liveRoomParticipants: list }),
  setMatch: (currentMatch, matchId = null, partners = []) => set({ currentMatch, currentMatchId: matchId, currentPartners: partners }),
  setTimer: (timerSeconds) => set({ timerSeconds }),
  setTimerEndsAt: (timerEndsAt) => set((s) => {
    // Whenever endsAt is updated, immediately recompute the displayed
    // seconds. Pause path passes null and uses setTimer separately to
    // freeze the displayed value at the snapshot.
    if (!timerEndsAt) {
      // Bug 8.6 — skip the update when state is already null (avoids
      // re-renders from repeated paused timer:sync arrivals).
      if (s.timerEndsAt === null) return {};
      return { timerEndsAt: null };
    }
    const remaining = Math.max(0, Math.ceil((timerEndsAt.getTime() - Date.now()) / 1000));
    // Bug 8.6 — same-millisecond endsAt arrivals (the 2s periodic sync
    // sends the SAME endsAt repeatedly) should not trigger re-renders.
    // Compare timestamps not references.
    if (s.timerEndsAt && s.timerEndsAt.getTime() === timerEndsAt.getTime() && s.timerSeconds === remaining) {
      return {};
    }
    return { timerEndsAt, timerSeconds: remaining };
  }),
  tickTimer: () => set((s) => {
    // Bug 8.5 (April 19) — recompute from authoritative server endsAt
    // instead of decrementing a local counter. Decrementing was fragile
    // to tab throttling, sleep, clock skew, and missed syncs during
    // reconnect — producing >60s drift between host and participants.
    // When timerEndsAt is null (paused or no active timer), keep the
    // existing displayed value so paused snapshots stay frozen.
    if (!s.timerEndsAt || s.isPaused) return {};
    const remaining = Math.max(0, Math.ceil((s.timerEndsAt.getTime() - Date.now()) / 1000));
    // Bug 8.6 (April 19) — only emit a state update when the seconds
    // value actually CHANGED. Returning {timerSeconds: same} still
    // makes Zustand re-render subscribers and was causing the breakout
    // controls + timer to "blink" 3+ times/sec (1s tick + 2s sync).
    if (remaining === s.timerSeconds) return {};
    return { timerSeconds: remaining };
  }),
  setRound: (currentRound) => set({ currentRound }),
  addBroadcast: (msg) => set((s) => ({ broadcasts: [...s.broadcasts.slice(-9), msg] })),
  setError: (error) => set({ error }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
  setByeRound: (isByeRound) => set({ isByeRound }),
  setLiveKitToken: (liveKitToken, livekitUrl = null) => set({ liveKitToken, livekitUrl }),
  setRoomId: (currentRoomId) => set({ currentRoomId }),
  setLobbyToken: (lobbyToken, lobbyUrl = null, lobbyRoomId = null) => set({ lobbyToken, lobbyUrl, lobbyRoomId }),
  setTimerVisibility: (timerVisibility) => set({ timerVisibility }),
  setBreakoutTimerHidden: (breakoutTimerHidden) => set({ breakoutTimerHidden }),
  setMatchPreview: (matchPreview) => set({ matchPreview }),
  setEventPlanSummary: (eventPlanSummary) => set({ eventPlanSummary }),
  setTestMode: (testMode) => set({ testMode }),
  setHostMuteCommand: (muted) => set({ hostMuteCommand: muted }),
  setPartnerDisconnected: (partnerDisconnected) => set({ partnerDisconnected }),
  setRoundDashboard: (roundDashboard) => set({ roundDashboard }),
  addChatMessage: (msg) => set((s) => {
    const messages = [...s.chatMessages, msg];
    if (messages.length > 200) {
      messages.splice(0, messages.length - 200);
    }
    return {
      chatMessages: messages,
      unreadChatCount: s.chatOpen ? s.unreadChatCount : s.unreadChatCount + 1,
    };
  }),
  setChatMessages: (chatMessages) => set({ chatMessages }),
  updateMessageReaction: (messageId, reactions) => set((s) => ({
    chatMessages: s.chatMessages.map(m => m.id === messageId ? { ...m, reactions } : m),
  })),
  clearChatMessages: () => set({ chatMessages: [], unreadChatCount: 0 }),
  setChatOpen: (chatOpen) => set((s) => ({ chatOpen, unreadChatCount: chatOpen ? 0 : s.unreadChatCount })),
  resetUnreadChat: () => set({ unreadChatCount: 0 }),
  setMatchingOverlay: (matchingOverlay) => set({ matchingOverlay, preparingMatches: false }),
  setPreparingMatches: (preparingMatches) => set({ preparingMatches }),
  setLobbyDensity: (lobbyDensity) => set({ lobbyDensity }),
  setCohosts: (userIds) => set({ cohosts: new Set(userIds) }),
  addCohost: (userId) => set((s) => { const c = new Set(s.cohosts); c.add(userId); return { cohosts: c }; }),
  removeCohost: (userId) => set((s) => { const c = new Set(s.cohosts); c.delete(userId); return { cohosts: c }; }),
  setHostVisibility: (userId, mode) => set((s) => ({
    hostVisibilityModes: { ...s.hostVisibilityModes, [userId]: mode },
  })),
  setHostVisibilityModes: (modes) => set({ hostVisibilityModes: modes }),
  setActingAsHostOverrides: (overrides) => set({ actingAsHostOverrides: overrides }),
  setHostMutedUserIds: (ids) => set({ hostMutedUserIds: new Set(ids) }),
  setServerPinnedUserId: (userId) => set({ serverPinnedUserId: userId }),
  setTileDemotedUserIds: (ids) => set({ tileDemotedUserIds: Array.isArray(ids) ? ids : [] }),
  setLeftCurrentRound: (leftCurrentRound) => set({ leftCurrentRound }),
  setLastRatedRound: (lastRatedRound) => set({ lastRatedRound }),
  addRatedMatchId: (matchId) => set((s) => {
    if (!matchId || s.ratedMatchIds.has(matchId)) return {};
    const next = new Set(s.ratedMatchIds);
    next.add(matchId);
    return { ratedMatchIds: next };
  }),
  setIsPaused: (isPaused) => set({ isPaused }),
  setTileReaction: (userId, emoji, displayName) => set((s) => ({
    tileReactions: {
      ...s.tileReactions,
      [userId]: { emoji, displayName, expiresAt: Date.now() + 8000 },
    },
  })),
  clearTileReaction: (userId) => set((s) => {
    if (!s.tileReactions[userId]) return {};
    const next = { ...s.tileReactions };
    delete next[userId];
    return { tileReactions: next };
  }),
  // Phase 5 — seq-guarded consumer of the versioned state:snapshot push.
  // Ignores stale/duplicate snapshots so out-of-order or replayed pushes
  // can never regress the participant list (monotonic-version contract).
  // The visible lobby tiles still come from the LiveKit-presence override
  // (useInRoomParticipants); this updates the store-backed list used where
  // LiveKit isn't mounted and establishes the seq-guarded channel.
  applyStateSnapshot: (snap) => set((s) => {
    if (!snap || typeof snap.seq !== 'number' || snap.seq <= s.snapshotSeq) return {};
    return {
      snapshotSeq: snap.seq,
      participants: snap.participants.map(p => ({ userId: p.userId, displayName: p.displayName })),
    };
  }),
  // T0-3 — apply server's authoritative session-state snapshot atomically.
  // Recomputes timer locally from the server's `endsAt` (clock-skew immune).
  // Does NOT touch fields the snapshot doesn't carry (currentMatch, broadcasts,
  // chat, etc.) — those have their own update paths.
  applyFullState: (snapshot) => set(() => {
    const endsAt = snapshot.timerEndsAt ? new Date(snapshot.timerEndsAt) : null;
    const timerSeconds = endsAt
      ? Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 1000))
      : snapshot.pausedTimeRemainingMs
      ? Math.max(0, Math.ceil(snapshot.pausedTimeRemainingMs / 1000))
      : 0;

    return {
      sessionStatus: snapshot.sessionStatus,
      currentRound: snapshot.currentRound,
      totalRounds: snapshot.totalRounds,
      // Bug 28 (19 May Ali + Stefan) — snapshot carries the bonus count
      // so cold-start clients render the "Bonus" badge immediately on
      // any post-bump round.
      bonusRoundsAdded: typeof (snapshot as any).bonusRoundsAdded === 'number'
        ? (snapshot as any).bonusRoundsAdded
        : 0,
      isPaused: snapshot.isPaused,
      timerEndsAt: endsAt,
      timerSeconds,
      hostUserId: snapshot.hostUserId,
      hostInLobby: snapshot.hostInLobby,
      participants: snapshot.connectedParticipants.map(p => ({
        userId: p.userId,
        displayName: p.displayName,
      })),
      cohosts: new Set(snapshot.cohosts),
      hostVisibilityModes: (snapshot.hostVisibilityModes as any) || {},
      actingAsHostOverrides: snapshot.actingAsHostOverrides || {},
      hostMutedUserIds: new Set(snapshot.hostMutedUserIds || []),
      timerVisibility: (snapshot.timerVisibility as any) || 'last_10s',
      // Bug 1 (18 May Stefan) — pull the live server pin so cold-start
      // clients (page refresh, reconnect) render the same big tile as
      // everyone else who's been here longer. Snapshot returns null when
      // no global pin is set.
      serverPinnedUserId: (snapshot as any).pinnedUserId ?? null,
      // Bug 26 (19 May Ali) — apply the director's tile demote list on
      // hydrate so refreshing clients render correct tile sizes from
      // the first frame.
      tileDemotedUserIds: Array.isArray((snapshot as any).tileDemotedUserIds)
        ? (snapshot as any).tileDemotedUserIds
        : [],
      // Bug 68 (18 May Stefan) — bundle the HCC participants list on
      // every snapshot. A newly-promoted cohost's snapshot fetch (fired
      // by permissions:updated) populates the drawer in the same tick
      // that isHost flips to true, eliminating the empty-HCC race.
      hccParticipants: (snapshot as any).hccParticipants ?? [],
      // Bug I (15 May Ali) — mark snapshot hydration complete so any UI
      // gated on "have we heard from the server yet" can render without
      // flickering between empty-state and hydrated state on refresh.
      sessionStateLoaded: true,
    };
  }),
  updateRoomStatus: (matchId, status, participants) => set((s) => {
    if (!s.roundDashboard) return {};
    return {
      roundDashboard: {
        ...s.roundDashboard,
        rooms: s.roundDashboard.rooms.map(r =>
          r.matchId === matchId ? { ...r, status, participants } : r
        ),
      },
    };
  }),
  reset: () => set({
    phase: 'lobby', connectionStatus: 'connecting', transitionStatus: null,
    sessionStatus: 'scheduled', hostInLobby: false, hostUserId: null, sessionStateLoaded: false, serverPinnedUserId: null, tileDemotedUserIds: [], hccParticipants: [], totalRounds: 5, bonusRoundsAdded: 0,
    participants: [], liveRoomParticipants: [], currentMatch: null, currentPartners: [], currentMatchId: null,
    timerSeconds: 0, timerEndsAt: null, currentRound: 0, broadcasts: [], error: null, tileReactions: {},
    isReconnecting: false, isByeRound: false, liveKitToken: null, livekitUrl: null, currentRoomId: null,
    lobbyToken: null, lobbyUrl: null, lobbyRoomId: null,
    timerVisibility: 'always_visible', breakoutTimerHidden: false, matchPreview: null,
    eventPlanSummary: null, testMode: false,
    hostMuteCommand: null, partnerDisconnected: false, roundDashboard: null,
    chatMessages: [], unreadChatCount: 0, chatOpen: false, matchingOverlay: null, preparingMatches: false, lobbyDensity: 'normal' as const,
    cohosts: new Set<string>(), hostVisibilityModes: {}, actingAsHostOverrides: {}, hostMutedUserIds: new Set<string>(), leftCurrentRound: false, lastRatedRound: 0, ratedMatchIds: new Set<string>(), isPaused: false,
    snapshotSeq: -1,
  }),
}));

// F3 (21 May Ali) — selector hook returning the REALTIME in-room
// participant list. When LiveKit is connected the LiveKit identity set
// is the authoritative "who is in the main room right now" signal (every
// viewer's SDK subscribes to the same server-side room state, so no
// socket-fan-out drift is possible). We still intersect with the
// socket-fed roster so we get the right displayName for each user;
// LiveKit-only users (server hasn't fan-broadcasted their join yet) fall
// back to the name LiveKit publishes (set in the token by the server).
// When LiveKit isn't mounted yet (pre-event waiting room, text-only
// fallback, host on the scheduled-state path) `liveRoomParticipants` is
// empty and the durable socket-fed roster is returned unchanged.
//
// Background: the 21 May tests showed counts drifting per viewer even
// after the morning M1 fix removed aggressive auto-LEFT — user confirmed
// "upon refresh the list works fine", meaning the snapshot is correct
// but the post-snapshot socket events (participant:joined/left) miss
// some clients. LiveKit room state is the only signal where every
// browser converges to the same view without depending on our fan-out.
export function useInRoomParticipants(): Participant[] {
  const storeParticipants = useSessionStore(s => s.participants);
  const liveRoomParticipants = useSessionStore(s => s.liveRoomParticipants);
  return useMemo(() => {
    if (liveRoomParticipants.length === 0) return storeParticipants;
    const storeByUserId = new Map(storeParticipants.map(p => [p.userId, p]));
    return liveRoomParticipants.map(lp => ({
      userId: lp.userId,
      displayName: storeByUserId.get(lp.userId)?.displayName || lp.displayName || '',
    }));
  }, [storeParticipants, liveRoomParticipants]);
}
