// client/src/features/calls/OutgoingCallCard.tsx
// "Calling {Name}…" with the two minutes counting down and Cancel (1 Nov 2026), on every screen while a call I
// rang waits for an answer: the call keeps ringing when I leave the profile or the thread I rang from. It sits
// above the phone's bottom bar and a profile's move bar, and the toasts are at the top, so none of them meet at
// 360px. Portalled to <body>: a page's animated wrapper keeps a transform that would carry a fixed card with it.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Phone, Video, X } from 'lucide-react';
import { useCallStore } from '@/stores/callStore';
import { withdrawCall } from './call-api';
import { callRoomPath, countdown } from './call-ring';

export default function OutgoingCallCard() {
  const call = useCallStore((s) => s.outgoing);
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!call) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call]);
  if (!call) return null;

  // The card goes at once. The server says what the withdraw ended as: when the callee accepted a moment before,
  // the call is on and the caller goes into the room after all (fix round 1). A withdraw that never reached the
  // server puts the card back while the call still rings, so the caller can try again or be answered.
  const cancel = async () => {
    useCallStore.getState().end(call.requestId);
    try {
      const outcome = await withdrawCall(call.requestId);
      if (outcome.status === 'accepted') navigate(callRoomPath(outcome.conversationId, outcome.kind));
    } catch {
      if (call.expiresAt > Date.now()) useCallStore.getState().setOutgoing(call);
    }
  };
  const Icon = call.kind === 'audio' ? Phone : Video;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-testid="call-outgoing"
      className="fixed left-[max(12px,env(safe-area-inset-left))] right-[max(12px,env(safe-area-inset-right))] z-[98] mx-auto max-w-sm rounded-2xl border border-gray-200 bg-white p-4 shadow-xl bottom-[calc(92px+env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red-light text-rsn-red">
          <Icon className="h-5 w-5 animate-pulse" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#1a1a2e]">Calling {call.partnerName}…</p>
          <p className="text-xs text-gray-500">
            {call.durationMin}-min {call.kind === 'audio' ? 'audio' : 'video'} call · <span className="tabular-nums">{countdown(call.expiresAt - now)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void cancel()}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm text-gray-600 hover:bg-gray-50"
        >
          <X className="h-4 w-4" aria-hidden="true" /> Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
