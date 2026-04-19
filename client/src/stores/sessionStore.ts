import { create } from 'zustand';

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
  totalRounds: number;
  participants: Participant[];
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
    }[];
    byeParticipants: { userId: string; displayName: string }[];
    reassignmentInProgress: boolean;
    eligibleMainRoomCount?: number;
  } | null;
  chatMessages: ChatMessage[];
  unreadChatCount: number;
  chatOpen: boolean;
  matchingOverlay: { roomCount: number; roundNumber: number } | null;
  preparingMatches: boolean;
  lobbyDensity: 'compact' | 'normal' | 'spacious';
  cohosts: Set<string>;
  leftCurrentRound: boolean;
  lastRatedRound: number;
  isPaused: boolean;
  // Bug 10 (April 19) — Meet/Zoom-style reactions anchored to the
  // participant's tile. Replaces the floating-animation-only UX so
  // people can actually see WHO reacted.
  tileReactions: Record<string, { emoji: string; displayName: string; expiresAt: number }>;

  setPhase: (phase: SessionPhase) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setTransitionStatus: (status: TransitionStatus) => void;
  setSessionStatus: (status: SessionStatus) => void;
  setHostInLobby: (inLobby: boolean) => void;
  setHostUserId: (hostUserId: string | null) => void;
  setTotalRounds: (total: number) => void;
  setParticipants: (p: Participant[]) => void;
  addParticipant: (p: Participant) => void;
  removeParticipant: (userId: string) => void;
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
  setLeftCurrentRound: (v: boolean) => void;
  setLastRatedRound: (r: number) => void;
  setIsPaused: (v: boolean) => void;
  // Bug 10 — reaction anchored to a participant tile for ~8s.
  setTileReaction: (userId: string, emoji: string, displayName: string) => void;
  clearTileReaction: (userId: string) => void;

  reset: () => void;
}

export const useSessionStore = create<SessionLiveState>((set) => ({
  phase: 'lobby',
  connectionStatus: 'connecting',
  transitionStatus: null,
  sessionStatus: 'scheduled',
  hostInLobby: false, hostUserId: null,
  totalRounds: 5,
  participants: [],
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
  leftCurrentRound: false,
  lastRatedRound: 0,
  isPaused: false,
  tileReactions: {},

  setPhase: (phase) => set({ phase }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setTransitionStatus: (transitionStatus) => set({ transitionStatus }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setHostInLobby: (hostInLobby) => set({ hostInLobby }),
  setHostUserId: (hostUserId) => set({ hostUserId }),
  setTotalRounds: (totalRounds) => set({ totalRounds }),
  setParticipants: (participants) => set({ participants }),
  addParticipant: (p) => set((s) => ({
    participants: s.participants.some(x => x.userId === p.userId) ? s.participants : [...s.participants, p],
  })),
  removeParticipant: (userId) => set((s) => ({
    participants: s.participants.filter(x => x.userId !== userId),
  })),
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
  setLeftCurrentRound: (leftCurrentRound) => set({ leftCurrentRound }),
  setLastRatedRound: (lastRatedRound) => set({ lastRatedRound }),
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
    sessionStatus: 'scheduled', hostInLobby: false, hostUserId: null, totalRounds: 5,
    participants: [], currentMatch: null, currentPartners: [], currentMatchId: null,
    timerSeconds: 0, timerEndsAt: null, currentRound: 0, broadcasts: [], error: null, tileReactions: {},
    isReconnecting: false, isByeRound: false, liveKitToken: null, livekitUrl: null, currentRoomId: null,
    lobbyToken: null, lobbyUrl: null, lobbyRoomId: null,
    timerVisibility: 'always_visible', breakoutTimerHidden: false, matchPreview: null,
    hostMuteCommand: null, partnerDisconnected: false, roundDashboard: null,
    chatMessages: [], unreadChatCount: 0, chatOpen: false, matchingOverlay: null, preparingMatches: false, lobbyDensity: 'normal' as const,
    cohosts: new Set<string>(), leftCurrentRound: false, lastRatedRound: 0, isPaused: false,
  }),
}));
