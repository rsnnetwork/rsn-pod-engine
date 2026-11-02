// ─── Incoming call REQUEST (9 Sep 2026, Ali/Stefan; every screen, 1 Nov 2026) ─────────────────────
//
// When someone rings, this shows on whatever screen the member is on, with the length they asked for:
// "{Name} is calling you", "{n}-min video call", Accept (into the room) and Decline (they are told). The call
// itself is held app-wide (stores/callStore.ts, filled by useCallSignals): the live call:request, or after a
// refresh what GET /dm/call/requests/incoming says is ringing. It goes when the caller withdraws, when it is
// answered or declined on another device, or when it lapses after 2 minutes. Clear of the notch: the top
// keeps env(safe-area-inset-top) above it.
// Final fix wave C2 (2 Nov 2026): z-[205], above every sheet's backdrop (z-[200]) so Accept is reached over an open
// sheet without closing it, and below the toasts (z-[210]).
// Final fix wave CM4 (2 Nov 2026): in a live event (where the chime is quiet) answering takes the member out of the
// event, which in a breakout ends the conversation without a word, so Accept asks first, inside the banner.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Video, Phone, X, Check } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { useCallStore } from '@/stores/callStore';
import { answerCall, declineCall } from '@/features/calls/call-api';
import { LEAVE_EVENT_FOR_CALL, callRoomPath, inLiveEvent, ringRefusal } from '@/features/calls/call-ring';

export default function IncomingCallBanner() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const addToast = useToastStore((s) => s.addToast);
  const req = useCallStore((s) => s.incoming);
  const [busy, setBusy] = useState(false);
  // The call the "Leave the event?" question is about: a new call rings with the question closed.
  const [askingFor, setAskingFor] = useState<string | null>(null);

  if (!req) return null;
  const asking = askingFor === req.requestId;
  const setAsking = (on: boolean) => setAskingFor(on ? req.requestId : null);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await answerCall(req.requestId);
      useCallStore.getState().end(req.requestId);
      navigate(callRoomPath(req.conversationId, req.kind));
    } catch (e) {
      addToast(ringRefusal(e), 'error');
      useCallStore.getState().end(req.requestId);
    } finally {
      setBusy(false);
    }
  };

  const onAccept = () => (inLiveEvent(pathname) ? setAsking(true) : void accept());

  const decline = async () => {
    if (busy) return;
    setBusy(true);
    useCallStore.getState().end(req.requestId);
    // Best-effort: the banner goes at once; a call nobody answers lapses on the server in two minutes anyway.
    try { await declineCall(req.requestId); } catch { /* the lapse covers it */ }
    setBusy(false);
  };

  const Icon = req.kind === 'audio' ? Phone : Video;
  const kindWord = req.kind === 'audio' ? 'audio' : 'video';
  return createPortal(
    <div
      className="fixed left-[max(12px,env(safe-area-inset-left))] right-[max(12px,env(safe-area-inset-right))] top-[calc(16px+env(safe-area-inset-top))] z-[205] mx-auto max-w-sm rounded-2xl border border-rsn-red/30 bg-white p-4 shadow-xl animate-fade-in-up"
      role="dialog"
      aria-label={`${req.partnerName} is calling you: a ${req.durationMin}-minute ${kindWord} call`}
      data-testid="call-incoming"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red-light text-rsn-red">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#1a1a2e]">{req.partnerName} is calling you</p>
          <p className="text-xs text-gray-500">{req.durationMin}-min {kindWord} call</p>
        </div>
      </div>
      {asking ? (
        <div data-testid="call-incoming-leave-event">
          <p className="mt-3 text-sm font-medium text-[#1a1a2e]" role="alert">{LEAVE_EVENT_FOR_CALL.question}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={busy}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {LEAVE_EVENT_FOR_CALL.stay}
            </button>
            <button
              type="button"
              onClick={() => void accept()}
              disabled={busy}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {LEAVE_EVENT_FOR_CALL.leave}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={decline}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" /> Decline
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Check className="h-4 w-4" aria-hidden="true" /> Accept
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
