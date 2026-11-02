// client/src/features/messages/thread-call-rules.ts
// What a thread's own call affordances offer (final fix wave C1, 2 Nov 2026). The header's buttons already follow
// these rules; the meeting pinned at the top of the thread and the button on a call line follow them too:
//   * nothing is offered with someone who is no longer a member of REASON (the header says so instead);
//   * a scheduled meeting still in play is joined;
//   * a call rings only when ringing is allowed: a video call needs canCall (any connection, 1 Nov 2026), an audio
//     call needs callsUnlocked (the pair's first meeting happened).
// The server still refuses a call it should not ring; these keep the screen from offering one.

export type CallKind = 'audio' | 'video';

const mayRing = (kind: CallKind, canCall: boolean, callsUnlocked: boolean) => (kind === 'video' ? canCall : callsUnlocked);

/** The pinned meeting: Join while it is in play; once over, Call now or "Pick a new time"; nothing for a former member. */
export function meetingBannerAction(o: {
  over: boolean; kind: CallKind; callsUnlocked: boolean; canCall: boolean; former: boolean;
}): 'join' | 'call' | 'pick-new-time' | null {
  if (o.former) return null;
  if (!o.over) return 'join';
  return mayRing(o.kind, o.canCall, o.callsUnlocked) ? 'call' : 'pick-new-time';
}

/** A call line's button: Join meeting while its meeting is in play, else a call when ringing is allowed, else none. */
export function messageCallAction(o: {
  scheduled: boolean; scheduledLive: boolean; kind: CallKind; canCall: boolean; callsUnlocked: boolean; former: boolean;
}): 'join' | 'call' | null {
  if (o.former) return null;
  if (o.scheduled && o.scheduledLive) return 'join';
  return mayRing(o.kind, o.canCall, o.callsUnlocked) ? 'call' : null;
}
