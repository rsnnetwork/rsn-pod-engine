// The event, as anyone holding its RSN Call link sees it (Part 2, Task 12; spec 02 "Open link"): its image (Part 3, a
// 3:1 strip at the top, when it has one), its title, its time on the event's own clock with the zone named (Part 3,
// K1), the host's name and photo, its format and length, and what it will ask for before entry. Never
// who else is in it: the landing does not carry that. "compact" is the one-line reminder above the later steps on a
// phone and a tablet.
import { useId } from 'react';
import { CalendarDays, Clock, ListChecks } from 'lucide-react';
import type { CallLanding } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import EventImage from '@/features/sessions/EventImage';
import { asksSentence, durationLabel, eventTimeLabel, formatLabelOf } from './call-entry';

function LifecycleChip({ lifecycle }: { lifecycle: CallLanding['lifecycle'] }) {
  if (lifecycle === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e8f7ef] px-2.5 py-1 text-[12px] font-bold text-reason-green-fill">
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-reason-green" /> Live now
      </span>
    );
  }
  if (lifecycle === 'cancelled') {
    return <span className="inline-flex rounded-full bg-reason-pink px-2.5 py-1 text-[12px] font-bold text-reason-red">Cancelled</span>;
  }
  if (lifecycle === 'completed' || lifecycle === 'archived') {
    return <span className="inline-flex rounded-full bg-reason-soft px-2.5 py-1 text-[12px] font-bold text-reason-muted">Ended</span>;
  }
  return null;
}

export default function CallEventSummary({ landing, variant = 'full' }: { landing: CallLanding; variant?: 'full' | 'compact' }) {
  const when = eventTimeLabel(landing.scheduledAt, landing.timezone);
  // The summary is drawn twice on the first screen (beside the step from 1024px, in it below): each its own heading id.
  const titleId = useId();
  if (variant === 'compact') {
    return (
      <div className="mb-5 flex min-w-0 items-center gap-3 rounded-2xl border border-reason-line bg-white px-3.5 py-3 sm:mb-6 sm:border-0 sm:bg-reason-soft" data-testid="call-event-compact">
        <Avatar src={landing.host.avatarUrl} name={landing.host.displayName} size="md" className="shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight">{landing.title}</p>
          <p className="truncate text-[13px] text-reason-muted">{when ?? 'Time to be announced'}</p>
        </div>
      </div>
    );
  }

  const length = durationLabel(landing.durationMinutes);
  const asks = asksSentence(landing.asks, landing.viewer.signedIn);
  return (
    <section aria-labelledby={titleId} data-testid="call-event-summary">
      {/* The hero: decorative (the title follows), and loaded at once, as the first thing on the page. */}
      <EventImage src={landing.imageUrl} variant="header" loading="eager" className="mb-4" />
      <LifecycleChip lifecycle={landing.lifecycle} />
      <h1 id={titleId} className="mt-2 break-words text-[26px] font-extrabold leading-[1.15] tracking-[-0.02em] sm:text-[30px]">
        {landing.title}
      </h1>
      <ul className="mt-4 space-y-2.5 text-[15px]">
        <li className="flex items-start gap-2.5">
          <CalendarDays aria-hidden="true" className="mt-0.5 h-[18px] w-[18px] shrink-0 text-reason-muted" />
          <span>{when ?? 'Time to be announced'}</span>
        </li>
        <li className="flex items-start gap-2.5">
          <Clock aria-hidden="true" className="mt-0.5 h-[18px] w-[18px] shrink-0 text-reason-muted" />
          <span>{formatLabelOf(landing.format)}{length ? ` · ${length}` : ''}</span>
        </li>
      </ul>
      <div className="mt-5 flex min-w-0 items-center gap-3">
        <Avatar src={landing.host.avatarUrl} name={landing.host.displayName} size="lg" className="shrink-0" />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-reason-muted">Hosted by</p>
          <p className="truncate text-[15px] font-bold">{landing.host.displayName}</p>
        </div>
      </div>
      {landing.description && (
        <p className="mt-5 whitespace-pre-line break-words text-[15px] leading-relaxed text-[#3b404b]">{landing.description}</p>
      )}
      {asks && (
        <p className="mt-5 flex items-start gap-2.5 rounded-2xl bg-reason-soft px-4 py-3 text-[14px] text-[#3b404b]" data-testid="call-asks">
          <ListChecks aria-hidden="true" className="mt-0.5 h-[18px] w-[18px] shrink-0 text-reason-muted" />
          <span>{asks}</span>
        </p>
      )}
    </section>
  );
}
