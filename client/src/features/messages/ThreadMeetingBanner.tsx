// The confirmed meeting, pinned at the top of the thread for BOTH people — real local time, duration, audio/video and
// a Join button — so the meeting is visible in the chat, not buried in the scheduler (Ali, 8 Sep 2026). Shares the
// scheduling query with the scheduler panel. Since 26 Oct 2026 a meeting has its own page, and the banner opens it.

import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, ChevronRight, Video, Phone } from 'lucide-react';
import { E } from '@/realtime/entities';
import api from '@/lib/api';
import { isMeetingOver, viewerZone, whenWithZone } from './scheduler-flow';
import { schedulingKey, type Scheduling } from './scheduling-types';

export default function ThreadMeetingBanner({ conversationId, onCallNow }: {
  conversationId: string; onCallNow?: (kind: 'audio' | 'video') => void;
}) {
  const navigate = useNavigate();
  const { data } = useQuery<Scheduling>({
    queryKey: schedulingKey(conversationId),
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    meta: { entities: [E.dmConversation(conversationId)] },
  });
  const c = data?.confirmed;
  if (!c || !c.startAt) return null;
  const zone = viewerZone();
  const kind = c.type ?? 'video';
  const callWord = kind === 'audio' ? 'Audio call' : 'Video call';
  const over = isMeetingOver(c.startAt, c.durationMin);
  // "Call now" after an ended meeting only makes sense once calls are unlocked
  // (both attended). If it ended without that, they pick a new time instead.
  const unlocked = !!data?.callsUnlocked;
  const summary = (
    <>
      <CalendarCheck className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-600'}`} />
      <span className="min-w-0">
        <span className={`block truncate text-sm font-semibold ${over ? 'text-gray-600' : 'text-emerald-800'}`}>
          {over ? 'Meeting ended' : whenWithZone(c.startAt, zone)}
        </span>
        <span className={`block truncate text-[11px] ${over ? 'text-gray-500' : 'text-emerald-700'}`}>
          {over ? `${callWord} · ${whenWithZone(c.startAt, zone)}` : `${callWord} · ${c.durationMin} min`}
        </span>
      </span>
    </>
  );
  // One row at every width: the words give way (truncate), never Join. On a
  // short phone a second row would take the thread's last lines with it.
  return (
    <div
      className={`border-b px-4 py-2.5 ${over ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50'}`}
      data-testid="thread-meeting-banner"
    >
      <div className="flex items-center justify-between gap-3">
        {c.meetingId ? (
          <Link
            to={`/meetings/${c.meetingId}`}
            className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg hover:opacity-80"
            title="See the meeting's details"
          >
            {summary}
            <ChevronRight className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-700'}`} aria-hidden="true" />
            <span className="sr-only">See the meeting's details</span>
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{summary}</div>
        )}
        {over ? (
          unlocked ? (
            <button
              onClick={() => onCallNow?.(kind)}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-rsn-red px-3 text-sm font-medium text-white hover:opacity-90"
            >
              {kind === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Call now
            </button>
          ) : (
            <span className="text-xs text-gray-500">Pick a new time to meet.</span>
          )
        ) : (
          <button
            onClick={() => navigate(`/meet/${conversationId}?kind=${kind}&scheduled=1`)}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {kind === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
          </button>
        )}
      </div>
    </div>
  );
}
