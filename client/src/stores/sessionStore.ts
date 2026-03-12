import { create } from 'zustand';

interface Participant {
  userId: string;
  displayName?: string;
}

interface MatchPartner {
  userId: string;
  displayName?: string;
}

type SessionPhase = 'lobby' | 'matched' | 'rating' | 'complete';
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type TransitionStatus = 
  | null
  | 'starting_session'
  | 'preparing_match'
  | 'round_ending'
  | 'between_rounds'
  | 'session_ending';
type SessionStatus = 'scheduled' | 'lobby_open' | 'round_active' | 'round_rating' | 'round_transition' | 'closing_lobby' | 'completed' | 'cancelled';

interface SessionLiveState {
  phase: SessionPhase;
  connectionStatus: ConnectionStatus;
  transitionStatus: TransitionStatus;
  sessionStatus: SessionStatus;
  hostInLobby: boolean;
  totalRounds: number;
  participants: Participant[];
  currentMatch: MatchPartner | null;
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
  timerVisibility: 'hidden' | 'always_visible' | 'last_30s' | 'last_60s' | 'last_120s';
  matchPreview: {
    roundNumber: number;
    matches: { participantA: { userId: string; displayName: string }; participantB: { userId: string; displayName: string } }[];
    byeParticipants: { userId: string; displayName: string }[];
  } | null;

  setPhase: (phase: SessionPhase) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setTransitionStatus: (status: TransitionStatus) => void;
  setSessionStatus: (status: SessionStatus) => void;
  setHostInLobby: (inLobby: boolean) => void;
  setTotalRounds: (total: number) => void;
  setParticipants: (p: Participant[]) => void;
  addParticipant: (p: Participant) => void;
  removeParticipant: (userId: string) => void;
  setMatch: (m: MatchPartner | null, matchId?: string | null) => void;
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
  setTimerVisibility: (v: 'hidden' | 'always_visible' | 'last_30s' | 'last_60s' | 'last_120s') => void;
  setMatchPreview: (preview: SessionLiveState['matchPreview']) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionLiveState>((set) => ({
  phase: 'lobby',
  connectionStatus: 'connecting',
  transitionStatus: null,
  sessionStatus: 'scheduled',
  hostInLobby: false,
  totalRounds: 5,
  participants: [],
  currentMatch: null,
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
  timerVisibility: 'always_visible',
  matchPreview: null,

  setPhase: (phase) => set({ phase }),
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setTransitionStatus: (transitionStatus) => set({ transitionStatus }),
  setSessionStatus: (sessionStatus) => set({ sessionStatus }),
  setHostInLobby: (hostInLobby) => set({ hostInLobby }),
  setTotalRounds: (totalRounds) => set({ totalRounds }),
  setParticipants: (participants) => set({ participants }),
  addParticipant: (p) => set((s) => ({
    participants: s.participants.some(x => x.userId === p.userId) ? s.participants : [...s.participants, p],
  })),
  removeParticipant: (userId) => set((s) => ({
    participants: s.participants.filter(x => x.userId !== userId),
  })),
  setMatch: (currentMatch, matchId = null) => set({ currentMatch, currentMatchId: matchId }),
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
  reset: () => set({
    phase: 'lobby', connectionStatus: 'connecting', transitionStatus: null,
    sessionStatus: 'scheduled', hostInLobby: false, totalRounds: 5,
    participants: [], currentMatch: null, currentMatchId: null,
    timerSeconds: 0, currentRound: 0, broadcasts: [], error: null,
    isReconnecting: false, isByeRound: false, liveKitToken: null, livekitUrl: null, currentRoomId: null,
    lobbyToken: null, lobbyUrl: null, lobbyRoomId: null,
    timerVisibility: 'always_visible', matchPreview: null,
  }),
}));
