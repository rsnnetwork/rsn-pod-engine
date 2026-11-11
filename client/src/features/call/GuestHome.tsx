// /my-events (Part 2, Task 12): the events someone joined, or asked to join, from an RSN Call link, each opening its
// link again (which takes them in, says they are in, or says why not). For an event guest it is home, with the offer to
// become a member; a member reaches it too, as one more list of their events.
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarDays, Sparkles } from 'lucide-react';
import { callLinkPath, type CallEventSummary } from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import EventImage from '@/features/sessions/EventImage';
import { CALL_WORDS, eventTimeLabel } from './call-entry';
import { isEventGuest } from './guest-routes';
import { useMyCallEvents } from './useCallLink';

const STEP_CHIP: Record<CallEventSummary['step'], { label: string; tone: 'live' | 'good' | 'wait' | 'muted' | 'bad' }> = {
  enter: { label: 'Live now', tone: 'live' },
  wait_for_start: { label: "You're in", tone: 'good' },
  pending_approval: { label: 'Waiting for approval', tone: 'wait' },
  waitlisted: { label: 'On the waiting list', tone: 'wait' },
  request: { label: 'Not asked yet', tone: 'muted' },
  details: { label: 'Finish joining', tone: 'wait' },
  identify: { label: 'Finish joining', tone: 'wait' },
  declined: { label: 'Not approved', tone: 'bad' },
  refused: { label: 'Not open to you', tone: 'bad' },
  ended: { label: 'Ended', tone: 'muted' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

const TONE = {
  live: 'bg-[#e8f7ef] text-reason-green-fill',
  good: 'bg-[#e8f7ef] text-reason-green-fill',
  wait: 'bg-[#fff5e6] text-[#8a560f]',
  muted: 'bg-reason-soft text-reason-muted',
  bad: 'bg-reason-pink text-reason-red',
} as const;

function EventCard({ event }: { event: CallEventSummary }) {
  const navigate = useNavigate();
  const chip = STEP_CHIP[event.step];
  const when = eventTimeLabel(event.scheduledAt, event.timezone);
  const over = event.step === 'ended' || event.step === 'cancelled';
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-reason-line bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5" data-testid="guest-event">
      <div className="min-w-0 sm:flex-1">
        <EventImage src={event.imageUrl} className="mb-3" />
        <span className={cn('inline-flex rounded-full px-2.5 py-1 text-[12px] font-bold', TONE[chip.tone])}>{chip.label}</span>
        <p className="mt-2 break-words text-[17px] font-bold leading-snug">{event.title}</p>
        <p className="mt-1 flex items-center gap-1.5 text-[14px] text-reason-muted">
          <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{when ?? 'Time to be announced'}</span>
        </p>
      </div>
      <Button
        variant={event.step === 'enter' ? 'primary' : over ? 'ghost' : 'secondary'}
        size="lg"
        className="w-full shrink-0 rounded-2xl sm:w-auto"
        onClick={() => navigate(callLinkPath(event.code))}
      >
        {event.step === 'enter' ? 'Join now' : 'Open'}
        <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
      </Button>
    </li>
  );
}

function BecomeMember({ email }: { email: string | undefined }) {
  const navigate = useNavigate();
  const to = email ? `/request-to-join?email=${encodeURIComponent(email)}` : '/request-to-join';
  return (
    <section className="rounded-2xl border border-[#f3dcb8] bg-[#fff8ec] p-4 sm:p-5" data-testid="guest-become-member">
      <p className="flex items-start gap-2.5 text-[15px] font-semibold">
        <Sparkles aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-reason-amber" />
        <span>{CALL_WORDS.becomeMember}</span>
      </p>
      <p className="mt-1.5 text-[14px] text-reason-muted sm:pl-[30px]">
        Members find people with a reason to meet them, message them and join pods and circles.
      </p>
      <Button size="lg" className="mt-3 w-full rounded-2xl sm:ml-[30px] sm:w-auto" onClick={() => navigate(to)}>
        Ask to become a member
      </Button>
    </section>
  );
}

export default function GuestHome() {
  const user = useAuthStore((s) => s.user);
  const guest = isEventGuest(user);
  const events = useMyCallEvents();

  return (
    <div className="space-y-6" data-testid="guest-home">
      <header>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-[-0.03em] sm:text-[34px]">Your events</h1>
        <p className="mt-1.5 text-[15px] text-reason-muted">The events you joined from a link. Open one to go in.</p>
      </header>

      {events.isPending && (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading your events">
          {[0, 1].map((i) => (
            <li key={i} className="rounded-2xl border border-reason-line bg-white p-5">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="mt-3 h-5 w-3/4" />
              <Skeleton className="mt-2 h-4 w-1/2" />
            </li>
          ))}
        </ul>
      )}

      {events.isError && (
        <div role="alert" className="rounded-2xl border border-reason-line bg-white p-5">
          <p className="text-[15px] font-semibold">We couldn&apos;t load your events just now.</p>
          <Button variant="secondary" className="mt-3 rounded-xl" onClick={() => void events.refetch()}>Try again</Button>
        </div>
      )}

      {events.data && events.data.length === 0 && (
        <div className="rounded-2xl border border-dashed border-reason-line bg-white p-6 text-center" data-testid="guest-events-empty">
          <p className="text-[16px] font-bold">No events yet</p>
          <p className="mt-1 text-[14px] text-reason-muted">Open an event&apos;s link to join it, and it will be here.</p>
        </div>
      )}

      {events.data && events.data.length > 0 && (
        <ul className="space-y-3">
          {events.data.map((event) => <EventCard key={event.code} event={event} />)}
        </ul>
      )}

      {guest && <BecomeMember email={user?.email} />}
    </div>
  );
}
