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
    }[];
    byeParticipants: { userId: string; displayName: string }[];
    reassignmentInProgress: boolean;
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
  setTimer: (s: number) => void;
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
  timerVisibility: 'last_10s',
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
  tickTimer: () => set((s) => ({ timerSeconds: Math.max(0, s.timerSeconds - 1) })),
  setRound: (currentRound) => set({ currentRound }),
  addBroadcast: (msg) => set((s) => ({ broadcasts: [...s.broadcasts.slice(-9), msg] })),
  setError: (error) => set({ error }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
  setByeRound: (isByeRound) => set({ isByeRound }),
  setLiveKitToken: (liveKitToken, livekitUrl = null) => set({ liveKitToken, livekitUrl }),
  setRoomId: (currentRoomId) => set({ currentRoomId }),
  setLobbyToken: (lobbyToken, lobbyUrl = null, lobbyRoomId = null) => set({ lobbyToken, lobbyUrl, lobbyRoomId }),
  setTimerVisibility: (timerVisibility) => set({ timerVisibility }),
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
    timerSeconds: 0, currentRound: 0, broadcasts: [], error: null,
    isReconnecting: false, isByeRound: false, liveKitToken: null, livekitUrl: null, currentRoomId: null,
    lobbyToken: null, lobbyUrl: null, lobbyRoomId: null,
    timerVisibility: 'last_10s', matchPreview: null,
    hostMuteCommand: null, partnerDisconnected: false, roundDashboard: null,
    chatMessages: [], unreadChatCount: 0, chatOpen: false, matchingOverlay: null, preparingMatches: false, lobbyDensity: 'normal' as const,
    cohosts: new Set<string>(), leftCurrentRound: false, lastRatedRound: 0,
  }),
}));
