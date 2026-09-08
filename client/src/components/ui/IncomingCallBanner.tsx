// ─── Incoming call REQUEST (9 Sep 2026, Ali/Stefan) ─────────────────────────
//
// Calls go request → accept once a pair's first meeting has happened. When the
// other person requests a call, this rings anywhere in the app with the length
// they asked for; Accept enters the room, Decline tells them. The request
// lapses after 2 minutes, and disappears if the caller withdraws it.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Phone, X, Check } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';

interface CallRequest {
  requestId: string;
  conversationId: string;
  fromUserId: string;
  fromName: string;
  kind: 'audio' | 'video';
  durationMin: number;
}

const REQUEST_TTL_MS = 2 * 60 * 1000;

export default function IncomingCallBanner() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const [req, setReq] = useState<CallRequest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const onRequest = (data: CallRequest) => setReq(data);
    const onCancelled = (data: { requestId: string }) =>
      setReq((cur) => (cur && cur.requestId === data.requestId ? null : cur));
    s.on('call:request', onRequest);
    s.on('call:cancelled', onCancelled);
    return () => {
      s.off('call:request', onRequest);
      s.off('call:cancelled', onCancelled);
    };
  }, []);

  // A request the callee never answers lapses on its own.
  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => setReq(null), REQUEST_TTL_MS);
    return () => clearTimeout(t);
  }, [req]);

  if (!req) return null;

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/dm/call/requests/${req.requestId}/accept`);
      const { conversationId, kind } = req;
      setReq(null);
      navigate(`/meet/${conversationId}?kind=${kind}`);
    } catch (e: any) {
      addToast(e?.response?.data?.error?.message || 'Could not accept the call.', 'error');
      setReq(null);
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.post(`/dm/call/requests/${req.requestId}/decline`); } catch { /* best-effort */ }
    setReq(null);
    setBusy(false);
  };

  const Icon = req.kind === 'audio' ? Phone : Video;
  return (
    <div
      className="fixed left-1/2 top-4 z-[100] w-[92%] max-w-sm -translate-x-1/2 rounded-2xl border border-rsn-red/30 bg-white p-4 shadow-xl animate-fade-in-up"
      role="dialog"
      aria-label={`${req.fromName} wants a ${req.durationMin}-minute ${req.kind} call`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red-light text-rsn-red">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#1a1a2e]">{req.fromName} wants to call</p>
          <p className="text-xs text-gray-500">{req.durationMin}-min {req.kind === 'audio' ? 'audio' : 'video'} call</p>
        </div>
        <button
          onClick={accept}
          disabled={busy}
          className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Check className="h-4 w-4" /> Accept
        </button>
        <button
          onClick={decline}
          disabled={busy}
          aria-label="Decline call"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
