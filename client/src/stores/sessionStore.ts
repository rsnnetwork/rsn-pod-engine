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

interface SessionLiveState {
  phase: SessionPhase;
  participants: Participant[];
  currentMatch: MatchPartner | null;
  currentMatchId: string | null;
  timerSeconds: number;
  currentRound: number;
  broadcasts: string[];
  error: string | null;
  isReconnecting: boolean;
  isByeRound: boolean;

  setPhase: (phase: SessionPhase) => void;
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
  reset: () => void;
}

export const useSessionStore = create<SessionLiveState>((set) => ({
  phase: 'lobby',
  participants: [],
  currentMatch: null,
  currentMatchId: null,
  timerSeconds: 0,
  currentRound: 1,
  broadcasts: [],
  error: null,
  isReconnecting: false,
  isByeRound: false,

  setPhase: (phase) => set({ phase }),
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
  reset: () => set({
    phase: 'lobby', participants: [], currentMatch: null, currentMatchId: null,
    timerSeconds: 0, currentRound: 1, broadcasts: [], error: null,
    isReconnecting: false, isByeRound: false,
  }),
}));
