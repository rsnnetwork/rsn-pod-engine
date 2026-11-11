// The pair's meeting at the top of the scheduler: when (in the reader's own time), how long, audio or video, Join and
// Add to calendar. 11 Nov 2026 (RSN 09): "Calendar invitation sent by email." only when it was; else what is true,
// and Add manually is then the way, after Join and quieter than it. Once it is over (they did not both attend, or Reschedule opened the panel for a pair that has met),
// a line to pick a new time below.

import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Phone, Video } from 'lucide-react';
import AddToCalendar from '@/components/calendar/AddToCalendar';
import { meetingEntry } from '@/components/calendar/calendar-links';
import { conversationMeetingFile, meetingFile } from '@/components/calendar/calendar-files';
import { inviteEmailed, inviteLine } from '@/components/calendar/invite-words';
import { useConversationPartner } from './thread/useConversationPartner';
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
}

export default function SchedulerMeetingSummary({ conversationId, meeting, over, zone }: Props) {
  const navigate = useNavigate();
  const partner = useConversationPartner(conversationId);
  const kind = meeting.type ?? 'video';
  const callWord = meeting.type === 'audio' ? 'Audio call' : 'Video call';
  const invite = inviteLine(meeting.inviteEmail, false, 'card');
  const emailed = inviteEmailed(meeting.inviteEmail);
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
          {invite && <p className="text-xs font-medium text-emerald-800" data-testid="invite-line">{invite}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => navigate(`/meet/${conversationId}?kind=${meeting.type ?? 'video'}&scheduled=1`)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {meeting.type === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
            </button>
            {/* Google Calendar, Outlook.com or the meeting's file (1 Nov 2026, T7). */}
            <AddToCalendar
              entry={meetingEntry({
                partnerName: partner?.name ?? 'your match',
                kind,
                startAt: meeting.startAt,
                durationMin: meeting.durationMin ?? 30,
                joinUrl: `${window.location.origin}/meet/${conversationId}?scheduled=1&kind=${kind}`,
              })}
              file={meeting.meetingId ? meetingFile(meeting.meetingId) : conversationMeetingFile(conversationId)}
              icon={<CalendarCheck className="h-4 w-4" />}
              emailed={emailed}
              className={emailed
                ? 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-emerald-700 underline-offset-2 hover:underline'
                : 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100'}
            />
          </div>
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
