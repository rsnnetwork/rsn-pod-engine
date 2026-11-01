// ─── Leaving a live event tells the server once (P1 item 7) ──────────────────────────────────────────────────────
//
// Leave (the speed-networking page's and a video meeting's) tells the server at once, then the page moves to the
// event page; the live hook's clean-up also tells it, for a person who goes away without pressing Leave. Pressed,
// both ran, and the server heard session:leave twice. The clean-up now says nothing for the event the page has
// already left. Pure apart from the one remembered id, so a test can run it: t16-p1-polish.test.ts.

/** The one event a Leave press has already told the server about, until the live hook's clean-up has run. */
let leftByPage: string | null = null;

export interface LeaveSignal {
  emit(event: 'session:leave', data: { sessionId: string }): unknown;
}

/** Leave pressed: the server hears it now, and the clean-up that follows will not say it again. */
export function leaveEvent(socket: LeaveSignal | null | undefined, sessionId: string): void {
  socket?.emit('session:leave', { sessionId });
  leftByPage = sessionId;
}

/** The live hook's clean-up: tells the server unless Leave already did for this event. */
export function leaveOnUnmount(socket: LeaveSignal, sessionId: string): void {
  if (leftByPage === sessionId) {
    leftByPage = null;
    return;
  }
  socket.emit('session:leave', { sessionId });
}
