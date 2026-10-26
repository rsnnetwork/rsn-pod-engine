// ─── The end of a video meeting (26 Oct 2026, VID-03) ──────────────────────────
//
// A meeting has no rounds and no ratings, so it does not end on the speed-networking
// recap ("You attended 0 rounds…", all zeros on 25 Oct): it says the meeting ended and
// offers the way back to the event and to its pod. Someone the host removed sees that
// instead (the kick is terminal: useSessionSocket locks the phase).

import { useNavigate } from 'react-router-dom';
import { CheckCircle2, UserX } from 'lucide-react';

const ACTION = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-5 text-sm font-semibold transition-colors';

export default function MeetingEnded({ sessionId, podId, removed }: { sessionId: string; podId?: string | null; removed: boolean }) {
  const navigate = useNavigate();
  const go = (to: string) => navigate(to, { replace: true });
  return (
    <div data-testid="meeting-ended" className="flex flex-1 items-center justify-center overflow-y-auto bg-white px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${removed ? 'bg-gray-100 text-gray-500' : 'bg-emerald-50 text-emerald-600'}`}>
          {removed ? <UserX className="h-7 w-7" aria-hidden="true" /> : <CheckCircle2 className="h-7 w-7" aria-hidden="true" />}
        </div>
        <h2 className="text-xl font-semibold text-[#1a1a2e]">
          {removed ? 'You were removed from this meeting' : 'Meeting ended'}
        </h2>
        {removed && <p className="mt-2 text-sm text-gray-600">The host removed you, so you can't rejoin it.</p>}
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {removed ? (
            <button type="button" className={`${ACTION} bg-[#1a1a2e] text-white hover:bg-[#2a2a40]`} onClick={() => go('/sessions')}>
              Back to events
            </button>
          ) : (
            <button type="button" className={`${ACTION} bg-[#1a1a2e] text-white hover:bg-[#2a2a40]`} onClick={() => go(`/sessions/${sessionId}`)}>
              Back to event
            </button>
          )}
          {podId && (
            <button type="button" className={`${ACTION} border border-gray-300 bg-white text-gray-800 hover:bg-gray-100`} onClick={() => go(`/pods/${podId}`)}>
              Back to pod
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
