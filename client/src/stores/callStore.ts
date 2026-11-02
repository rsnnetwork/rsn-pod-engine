// ─── The call ringing now, on this device (1 Nov 2026, 30 Oct review item 4) ───────────────────────
//
// Live, ephemeral call state, so Zustand and not React Query: the call ringing me (the banner), and the call I
// rang that is still waiting (the "Calling…" card). Either can be on screen from any page, so the app holds them
// once, above every route (features/calls/CallLayer.tsx). The server is the source of truth: the socket's
// call:* events set and clear them at once, and GET /dm/call/requests/incoming and /outgoing bring them back
// after a refresh or a lost connection (useCallSignals). Nothing here outlives a call: it is answered, declined,
// withdrawn or lapses after two minutes.

import { create } from 'zustand';
import type { RingingCall } from '@/features/calls/call-ring';

export interface CallState {
  incoming: RingingCall | null;
  outgoing: RingingCall | null;
  setIncoming: (call: RingingCall | null) => void;
  setOutgoing: (call: RingingCall | null) => void;
  /** This request is over (answered, declined, withdrawn or lapsed): take it off whichever side shows it. */
  end: (requestId: string) => void;
}

export const useCallStore = create<CallState>((set) => ({
  incoming: null,
  outgoing: null,
  setIncoming: (call) => set({ incoming: call }),
  setOutgoing: (call) => set({ outgoing: call }),
  end: (requestId) => set((s) => ({
    incoming: s.incoming?.requestId === requestId ? null : s.incoming,
    outgoing: s.outgoing?.requestId === requestId ? null : s.outgoing,
  })),
}));
