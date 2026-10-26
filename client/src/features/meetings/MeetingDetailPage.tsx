// client/src/features/meetings/MeetingDetailPage.tsx
// A meeting's own page (26 Oct 2026, CON-04/05), inside the shell under Events: who, when (in the reader's own time,
// the zone named), how, and why (the words on the request that connected the two); then Join from 5 minutes before,
// Add to calendar, Reschedule, Cancel, and the conversation. On a phone Join sits in a bar above the bottom bar.
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, CalendarPlus, MessageCircle, Phone, Video } from 'lucide-react';
import type { Meeting } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '@/features/reason/ui/Sheet';
import { CONNECTION_LOST } from '@/features/reason/errors';
import { isGone, personHref } from '@/features/reason/human/profile-text';
import { ACTION, JoinOrCountdown, PhaseChip } from './MeetingParts';
import { useCancelMeeting, useMeeting, useNow } from './useMeetings';
import {
  canJoin, isMeetingId, kindLabel, meetingChip, meetingDay, meetingError, meetingLine, meetingTimes, nextChangeAt,
  MEETING_GONE,
} from './meeting-words';

const SECONDARY = 'border border-reason-line bg-white text-[#2d3440] hover:bg-[#f5f6f7]';
// The countdown ("Starts in 25 min") moves by the minute; Join itself opens at its exact moment.
const TICK_MS = 30_000;

export default function MeetingDetailPage() {
  const { meetingId = '' } = useParams();
  const valid = isMeetingId(meetingId);
  // Lower-cased, so the page shares its read with the Events count, which names the meeting as the server does.
  const { data: meeting, error, isError, fetchStatus, refetch } = useMeeting(valid ? meetingId.toLowerCase() : null);
  const location = useLocation();
  const navigate = useNavigate();
  // The first page of the app in this tab (a link from an email or a bell): going back would leave the app, so it goes
  // to Events instead, and `replace` keeps the browser's own Back from returning here.
  const back = () => (location.key === 'default' ? navigate('/sessions', { replace: true }) : navigate(-1));

  let body: ReactNode;
  // A 404 that arrives while the meeting is on screen (a block between the two) takes it away, too.
  if (!valid || isGone(error)) body = <Gone />;
  else if (meeting) body = <MeetingView meeting={meeting} />;
  else if (isError || fetchStatus === 'paused') body = <Failed offline={fetchStatus === 'paused'} onRetry={() => void refetch()} />;
  else body = <Loading />;

  return (
    <div className="mx-auto w-full max-w-[760px] font-reason text-reason-ink">
      <button type="button" onClick={back} className="mb-4 min-h-[44px] rounded-full border border-reason-line bg-white px-3.5 text-[13px] font-extrabold">← Back</button>
      {body}
    </div>
  );
}

function MeetingView({ meeting }: { meeting: Meeting }) {
  const now = useNow(TICK_MS, (at) => nextChangeAt([meeting], at));
  const [confirming, setConfirming] = useState(false);
  const chip = meetingChip(meeting, now);
  // Still to come or under way: it can be joined, added to a calendar, moved or cancelled.
  const standing = meeting.status === 'scheduled' && chip !== 'Ended';

  return (
    <>
      <header className="mb-5">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#646a77]">Meeting</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-[28px] font-extrabold leading-[1.05] tracking-[-0.04em] [overflow-wrap:anywhere] min-[721px]:text-[36px]">
            Meeting with {meeting.partner.displayName}
          </h1>
          {chip && <PhaseChip chip={chip} />}
        </div>
        {!standing && (
          <p className="mt-2 text-[14px] text-reason-muted">
            {meeting.status === 'cancelled' ? 'This meeting was cancelled. You can pick a new time in your conversation.' : 'This meeting has ended.'}
          </p>
        )}
      </header>
      <MeetingFacts meeting={meeting} />
      <MeetingActions meeting={meeting} now={now} standing={standing} onCancel={() => setConfirming(true)} />
      {standing && <JoinBar meeting={meeting} now={now} />}
      {/* Closed too when the meeting stops standing under it (the other person cancelled, or it ended). */}
      <CancelSheet open={confirming && standing} meeting={meeting} onClose={() => setConfirming(false)} />
    </>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3.5 min-[721px]:grid-cols-[96px_minmax(0,1fr)] min-[721px]:gap-4">
      <dt className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#646a77] min-[721px]:pt-1">{term}</dt>
      <dd className="min-w-0 text-[15px] leading-snug">{children}</dd>
    </div>
  );
}

/** Who, when, how and why. Both people link to their profiles, in this tab: Back returns here. */
function MeetingFacts({ meeting }: { meeting: Meeting }) {
  const me = useAuthStore((s) => s.user);
  const name = meeting.partner.displayName;
  const KindIcon = meeting.kind === 'audio' ? Phone : Video;
  return (
    <dl className="divide-y divide-reason-line overflow-hidden rounded-2xl border border-reason-line bg-white">
      <Fact term="Who">
        <ul className="-my-1.5 flex flex-wrap gap-x-5">
          <li>
            <Link to={personHref(meeting.partner.userId, 'Events')} className="flex min-h-[44px] items-center gap-2.5 font-bold [overflow-wrap:anywhere] hover:underline">
              <Avatar src={meeting.partner.avatarUrl} name={name} size="sm" className="shrink-0" />
              {name}
            </Link>
          </li>
          <li>
            <Link to="/profile" className="flex min-h-[44px] items-center gap-2.5 hover:underline">
              <Avatar src={me?.avatarUrl} name={me?.displayName || 'You'} size="sm" className="shrink-0" />
              You
            </Link>
          </li>
        </ul>
      </Fact>
      <Fact term="When">
        <p className="font-bold">{meetingDay(meeting.startAt)}</p>
        <p className="mt-0.5 text-[#4b5260]">{meetingTimes(meeting.startAt, meeting.durationMin)} · {meeting.durationMin} min</p>
      </Fact>
      <Fact term="How">
        <p className="flex items-center gap-2"><KindIcon aria-hidden="true" className="h-4 w-4 text-[#4b5260]" /> {kindLabel(meeting.kind)} call</p>
      </Fact>
      {meeting.context && (
        <Fact term="Why">
          <p className="whitespace-pre-line [overflow-wrap:anywhere]">“{meeting.context.trim()}”</p>
        </Fact>
      )}
    </dl>
  );
}

interface ActionsProps { meeting: Meeting; now: number; standing: boolean; onCancel: () => void }

function MeetingActions({ meeting, now, standing, onCancel }: ActionsProps) {
  const addToast = useToastStore((s) => s.addToast);
  // The meeting as a calendar file any calendar opens, with the identity the emailed invite has, so adding it again
  // updates that entry instead of adding a second one.
  const addToCalendar = async () => {
    try {
      const res = await api.get(`/dm/conversations/${encodeURIComponent(meeting.conversationId)}/meeting.ics`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reason-meeting.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      addToast(meetingError(err, 'We could not make the calendar file. Try again in a moment.'), 'error');
    }
  };

  return (
    <div className="mt-4 grid gap-2 min-[721px]:flex min-[721px]:flex-wrap min-[721px]:items-center">
      {/* On a phone Join is in the bar at the foot of the screen instead. */}
      {standing && <JoinOrCountdown meeting={meeting} now={now} className="hidden min-[721px]:inline-flex" />}
      {standing && (
        <button type="button" onClick={() => void addToCalendar()} className={cn(ACTION, SECONDARY)}>
          <CalendarPlus aria-hidden="true" className="h-4 w-4" /> Add to calendar
        </button>
      )}
      {standing && (
        <Link to={`/messages/${encodeURIComponent(meeting.conversationId)}?schedule=1`} className={cn(ACTION, SECONDARY)}>
          <CalendarClock aria-hidden="true" className="h-4 w-4" /> Reschedule
        </Link>
      )}
      <Link to={`/messages/${encodeURIComponent(meeting.conversationId)}`} className={cn(ACTION, SECONDARY)}>
        <MessageCircle aria-hidden="true" className="h-4 w-4" /> Open conversation
      </Link>
      {standing && (
        <button type="button" onClick={onCancel} className={cn(ACTION, 'text-reason-red-hover hover:bg-reason-pink min-[721px]:ml-auto')}>
          Cancel meeting
        </button>
      )}
    </div>
  );
}

/**
 * Join on a phone: a bar that sits on the bottom bar while the page scrolls under it. A sticky box keeps to its scroll
 * area's padding, and <main> keeps 96px plus the home-indicator inset clear at its foot (ReasonShell) for the bottom
 * bar, which is 69px plus the same inset tall (MobileNav: a 1px border, 6px above, a 56px tab, 6px below): so -27px
 * sets it down onto the bar, whatever the inset. It runs edge to edge, its sides kept clear of the notch the way
 * <main>'s are.
 */
function JoinBar({ meeting, now }: { meeting: Meeting; now: number }) {
  return (
    <div className="sticky bottom-[-27px] z-10 -ml-[max(13px,env(safe-area-inset-left))] -mr-[max(13px,env(safe-area-inset-right))] mt-4 border-t border-reason-line bg-white/95 pb-2.5 pl-[max(13px,env(safe-area-inset-left))] pr-[max(13px,env(safe-area-inset-right))] pt-2.5 backdrop-blur-lg min-[721px]:hidden">
      <JoinOrCountdown meeting={meeting} now={now} className="w-full" />
      {!canJoin(meeting, now) && <p className="mt-1 text-center text-[12px] text-reason-muted">Join opens 5 minutes before the start.</p>}
    </div>
  );
}

function CancelSheet({ open, meeting, onClose }: { open: boolean; meeting: Meeting; onClose: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const cancel = useCancelMeeting(meeting.id);
  const name = meeting.partner.displayName;
  // A second press while the first is on its way is ignored: the server would answer it the same, but once is enough.
  const confirm = () => {
    if (cancel.isPending) return;
    cancel.mutate(undefined, {
      onSuccess: () => { onClose(); addToast('Meeting cancelled.', 'success'); },
      onError: (err) => { onClose(); addToast(meetingError(err, 'We could not cancel the meeting. Try again in a moment.'), 'error'); },
    });
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Cancel this meeting? ${name} will be told.`}
      footer={(
        <>
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Keep meeting</button>
          <button
            type="button"
            onClick={confirm}
            aria-disabled={cancel.isPending || undefined}
            className={cn('min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover', cancel.isPending && 'cursor-progress opacity-80')}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel meeting'}
          </button>
        </>
      )}
    >
      <p className="py-2 text-[14px] text-reason-muted">{meetingLine(meeting)}</p>
    </Sheet>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading the meeting</p>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="mt-3 h-9 w-[min(420px,90%)]" />
      <Skeleton className="mt-5 h-[220px]" />
      <Skeleton className="mt-4 h-11 w-[min(320px,100%)]" />
    </div>
  );
}

function Gone() {
  return (
    <div className="rounded-2xl border border-reason-line bg-white p-5">
      <h1 className="text-[20px] font-bold">{MEETING_GONE}</h1>
      <p className="mt-1 text-[14px] text-reason-muted">Your meetings are listed under Events.</p>
      <Link to="/sessions" className={cn(ACTION, 'mt-3 bg-reason-red text-white hover:bg-reason-red-hover')}>Go to Events</Link>
    </div>
  );
}

function Failed({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-5">
      <div>
        <h1 className="text-[18px] font-bold">We could not load this meeting just now.</h1>
        <p className="mt-1 text-[14px] text-reason-muted">{offline ? CONNECTION_LOST : 'Try again in a moment.'}</p>
      </div>
      <button type="button" onClick={onRetry} className={cn(ACTION, 'bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
    </div>
  );
}
