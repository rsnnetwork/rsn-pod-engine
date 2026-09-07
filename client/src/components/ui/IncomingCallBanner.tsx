// ─── Incoming 1:1 call ring (W-meet, 8 Sep 2026) ────────────────────────────
//
// When someone hits "Meet now", the callee gets a live ring anywhere in the app
// via the `call:incoming` socket event. Tapping Join opens the call room.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Phone, X } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface IncomingCall {
  conversationId: string;
  fromName: string;
  kind: 'audio' | 'video';
  link: string;
}

export default function IncomingCallBanner() {
  const navigate = useNavigate();
  const [call, setCall] = useState<IncomingCall | null>(null);

  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const onCall = (data: IncomingCall) => setCall(data);
    s.on('call:incoming', onCall);
    return () => { s.off('call:incoming', onCall); };
  }, []);

  // A ring shouldn't linger forever if the caller gives up.
  useEffect(() => {
    if (!call) return;
    const t = setTimeout(() => setCall(null), 45_000);
    return () => clearTimeout(t);
  }, [call]);

  if (!call) return null;

  return (
    <div className="fixed left-1/2 top-4 z-[100] w-[92%] max-w-sm -translate-x-1/2 rounded-2xl border border-rsn-red/30 bg-white p-4 shadow-xl animate-fade-in-up">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red-light text-rsn-red">
          {call.kind === 'audio' ? <Phone className="h-5 w-5" /> : <Video className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#1a1a2e]">{call.fromName} is calling</p>
          <p className="text-xs text-gray-500">{call.kind === 'audio' ? 'Audio call' : 'Video call'}</p>
        </div>
        <button
          onClick={() => { const link = call.link; setCall(null); navigate(link); }}
          className="min-h-[40px] shrink-0 rounded-lg bg-rsn-red px-4 text-sm font-medium text-white hover:opacity-90"
        >
          Join
        </button>
        <button onClick={() => setCall(null)} aria-label="Dismiss call" className="shrink-0 p-2 text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
