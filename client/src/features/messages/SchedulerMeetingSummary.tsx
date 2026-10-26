// The pair's meeting at the top of the scheduler: when (in the reader's own time), how long, audio or video, Join and
// Add to calendar. Once it is over (they did not both attend, or Reschedule opened the panel for a pair that has met),
// a line to pick a new time below.

import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Phone, Video } from 'lucide-react';
import { isSlotKey, dayLabel, slotLabel, whenWithZone } from './scheduler-flow';
import type { Scheduling } from './scheduling-types';

/** Any key in words: a slot on the reader's clock, or a legacy day part ("Wed 22 Jul, evening"). */
function labelFor(windowKey: string, zone: string): string {
  if (isSlotKey(windowKey)) return slotLabel(windowKey, zone);
  const [date, part] = windowKey.split(':');
  return `${dayLabel(date)}, ${part}`;
}

interface Props {
  conversationId: string;
  meeting: NonNullable<Scheduling['confirmed']>;
  over: boolean;
  zone: string;
  onAddToCalendar: () => void;
}

export default function SchedulerMeetingSummary({ conversationId, meeting, over, zone, onAddToCalendar }: Props) {
  const navigate = useNavigate();
  const callWord = meeting.type === 'audio' ? 'Audio call' : 'Video call';
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${over ? 'bg-gray-50 border-gray-200' : 'bg-emerald-50 border-emerald-200'}`}>
      <div className="flex items-center gap-2">
        <CalendarCheck className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-600'}`} />
        <p className={`text-sm font-semibold ${over ? 'text-gray-600' : 'text-emerald-800'}`}>
          {over
            ? 'Meeting ended'
            : meeting.startAt
              ? `Meeting confirmed — ${whenWithZone(meeting.startAt, zone)}`
              : `Meeting confirmed: ${labelFor(meeting.window, zone)}`}
        </p>
      </div>
      {meeting.startAt && !over && (
        <div className="mt-1 pl-6 space-y-1.5">
          <p className="text-xs text-emerald-700">
            {callWord} · {meeting.durationMin} minutes · shown in your local time
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => navigate(`/meet/${conversationId}?kind=${meeting.type ?? 'video'}&scheduled=1`)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {meeting.type === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
            </button>
            <button
              type="button"
              onClick={onAddToCalendar}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
            >
              <CalendarCheck className="h-4 w-4" /> Add to calendar
            </button>
          </div>
          <p className="text-[11px] text-emerald-700">A calendar invite was emailed to you both.</p>
        </div>
      )}
      {meeting.startAt && over && (
        <div className="mt-1 pl-6 space-y-1.5">
          <p className="text-xs text-gray-500">{callWord} · {whenWithZone(meeting.startAt, zone)}</p>
          <p className="text-xs text-gray-600">That meeting has passed. Pick a new time below.</p>
        </div>
      )}
    </div>
  );
}
