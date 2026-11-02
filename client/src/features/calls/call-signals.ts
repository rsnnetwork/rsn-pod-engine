// ─── What one tab does with the four call:* events (finding F3, 2 Nov 2026) ─────────────────────────
//
// The server sends each call event to every tab of the person (their user room), so each tab decides what is its own:
//   - call:request   → the banner (the call ringing me);
//   - call:accepted  → the tab that rang goes into the room; every other tab of the caller only ends its Calling card.
//                      Two tabs in the room with one identity and LiveKit puts one of them out ("client leave request
//                      reason: 2"), which sent the tab the member rang from back to the chat;
//   - call:declined  → the caller is told "{Name} can't take the call right now.";
//   - call:cancelled → the banner closes (withdrawn, or answered or declined on my other device).
// No React and no socket here, so a test can run two tabs side by side (server/src/__tests__/client/
// f3-one-tab-enters-the-call.test.ts); useCallSignals wires these to the socket.

import type { CallState } from '@/stores/callStore';
import { CALL_RING_MS, callRoomPath, type CallKind } from './call-ring';

export interface CallSignalDeps {
  /** This tab's call store, read afresh on each event. */
  store: () => CallState;
  navigate: (to: string) => void;
  toast: (message: string) => void;
}

export interface CallRequestSignal { requestId: string; conversationId: string; fromUserId: string; fromName: string; kind: CallKind; durationMin: number }
export interface CallAcceptedSignal { requestId: string; conversationId: string; kind: CallKind }
export interface CallDeclinedSignal { requestId: string; byName: string }
export interface CallCancelledSignal { requestId: string }

export function callSignalHandlers({ store, navigate, toast }: CallSignalDeps) {
  return {
    onRequest: (d: CallRequestSignal) => {
      const now = Date.now();
      store().setIncoming({
        requestId: d.requestId, conversationId: d.conversationId, partnerId: d.fromUserId, partnerName: d.fromName,
        kind: d.kind, durationMin: d.durationMin, expiresAt: now + CALL_RING_MS, seenAt: now, placedHere: false,
      });
    },
    onAccepted: (d: CallAcceptedSignal) => {
      const mine = store().outgoing;
      if (mine?.requestId !== d.requestId) return; // not a call this tab shows
      store().end(d.requestId);
      if (mine.placedHere) navigate(callRoomPath(d.conversationId, d.kind)); // rung elsewhere: that tab goes in
    },
    onDeclined: (d: CallDeclinedSignal) => {
      if (store().outgoing?.requestId !== d.requestId) return;
      store().end(d.requestId);
      toast(`${d.byName} can't take the call right now.`);
    },
    onCancelled: (d: CallCancelledSignal) => store().end(d.requestId),
  };
}
