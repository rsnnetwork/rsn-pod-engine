// "Join call", before the event starts (Part 2, Task 12): "You're in. {title} starts {when}.", Add to calendar, and the
// person's own meetings once the organisers have published a schedule. The page takes them in by itself when the event
// starts (the server's session:<id> tag). The same place says "Waiting for the organiser to approve you" for a request.
// Part 3 Task 8: and, on a full event, "{title} is full. You're number {n} on the waiting list." with the promise and
// "Leave the waiting list" (asked first). A promotion moves the page on by itself (session:<id>, session:<id>:waitlist).
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Hourglass, ListOrdered, Users } from 'lucide-react';
import type { CallLanding, MySchedule } from '@rsn/shared';
import AddToCalendar from '@/components/calendar/AddToCalendar';
import { eventEntry, icsFile } from '@/components/calendar/calendar-links';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { CALL_WORDS, waitlistedSentence, youreInSentence } from './call-entry';
import { GUEST_HOME_PATH } from './guest-routes';
import { useMySchedule } from './useCallLink';

interface Props {
  landing: CallLanding;
  kind: 'waiting' | 'pending' | 'waitlisted';
  sessionId: string | null;
  startsAt: string | null;
  guest: boolean;
  /** 'waitlisted': their number in the line (1 = next). */
  position?: number | null;
  /** 'waitlisted': take them off the line (the page says how it went). */
  onLeave?: () => Promise<void>;
  leaving?: boolean;
}

const CALENDAR_BUTTON = 'inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-reason-line bg-white px-4 text-[15px] font-bold text-reason-ink hover:bg-reason-soft';

function YourMeetings({ schedule }: { schedule: MySchedule }) {
  const rounds = schedule.rounds.filter((r) => r.partners.length > 0 || r.room !== null);
  if (rounds.length === 0) return null;
  return (
    <section aria-labelledby="call-your-meetings" className="rounded-2xl border border-reason-line bg-white p-4" data-testid="call-your-meetings">
      <h3 id="call-your-meetings" className="flex items-center gap-2 text-[15px] font-bold">
        <Users aria-hidden="true" className="h-4 w-4 text-reason-muted" /> Your meetings
      </h3>
      <ol className="mt-3 space-y-3">
        {rounds.map((r) => (
          <li key={r.round} className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-reason-soft text-[13px] font-bold">{r.round}</span>
            <div className="min-w-0">
              <p className="text-[13px] text-reason-muted">
                Round {r.round}{r.room !== null ? ` · Room ${r.room}` : ''}
              </p>
              {r.partners.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {r.partners.map((p, i) => (
                    <li key={`${p.displayName}-${i}`} className="flex min-w-0 items-center gap-2">
                      <Avatar src={p.avatarUrl} name={p.displayName} size="sm" className="shrink-0" />
                      <span className="truncate text-[14px] font-semibold">{p.displayName}</span>
                      {p.groupLabels.length > 0 && (
                        <span className="shrink-0 rounded-full bg-reason-soft px-2 py-0.5 text-[12px] text-reason-muted">{p.groupLabels.join(', ')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[14px] text-reason-muted">The organiser will place you.</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function CallWaitingStep({ landing, kind, sessionId, startsAt, guest, position = null, onLeave, leaving = false }: Props) {
  const navigate = useNavigate();
  const { ask, confirmDialog } = useConfirm();
  const schedule = useMySchedule(kind === 'waiting' ? sessionId : null);
  const home = guest ? GUEST_HOME_PATH : sessionId ? `/sessions/${sessionId}` : '/sessions';
  const homeLabel = guest ? 'Your events' : 'Open the event page';

  if (kind === 'waitlisted') {
    const leave = async () => {
      if (!onLeave) return;
      if (!(await ask({ title: CALL_WORDS.leaveWaitlistTitle, body: CALL_WORDS.leaveWaitlistBody, confirmLabel: CALL_WORDS.leaveWaitlist, tone: 'danger' }))) return;
      await onLeave();
    };
    return (
      <div className="space-y-4 text-center sm:text-left" data-testid="call-waitlisted">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#fff5e6] text-reason-amber sm:mx-0">
          <ListOrdered aria-hidden="true" className="h-6 w-6" />
        </div>
        <h2 className="break-words text-[22px] font-extrabold leading-tight tracking-[-0.01em]">
          {position !== null ? waitlistedSentence(landing.title, position) : `${landing.title} is full.`}
        </h2>
        <p className="text-[15px] text-reason-muted">{CALL_WORDS.waitlistMore}</p>
        <Button variant="secondary" size="lg" className="w-full rounded-2xl" onClick={() => navigate(home)}>{homeLabel}</Button>
        <Button
          variant="ghost"
          size="lg"
          className="w-full rounded-2xl"
          data-testid="call-leave-waitlist"
          isLoading={leaving}
          onClick={() => void leave()}
        >
          {CALL_WORDS.leaveWaitlist}
        </Button>
        {confirmDialog}
      </div>
    );
  }

  if (kind === 'pending') {
    return (
      <div className="space-y-4 text-center sm:text-left" data-testid="call-pending">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#fff5e6] text-reason-amber sm:mx-0">
          <Hourglass aria-hidden="true" className="h-6 w-6" />
        </div>
        <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em]">{CALL_WORDS.pending}</h2>
        <p className="text-[15px] text-reason-muted">{CALL_WORDS.pendingMore}</p>
        <Button variant="secondary" size="lg" className="w-full rounded-2xl" onClick={() => navigate(home)}>{homeLabel}</Button>
      </div>
    );
  }

  const pageUrl = `${window.location.origin}${window.location.pathname}`;
  const entry = startsAt
    ? eventEntry({ title: landing.title, startAt: startsAt, durationMin: landing.durationMinutes, pageUrl })
    : null;

  return (
    <div className="space-y-4" data-testid="call-waiting">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#e8f7ef] text-reason-green-fill">
        <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
      </div>
      <h2 className="break-words text-[22px] font-extrabold leading-tight tracking-[-0.01em]">{youreInSentence(landing.title, startsAt, landing.timezone)}</h2>
      <p className="text-[15px] text-reason-muted">
        Keep this link: it takes you straight in once the event starts. This page does that by itself if you leave it open.
      </p>
      {entry && (
        <AddToCalendar
          entry={entry}
          file={async () => icsFile(entry, `event-${landing.code}`)}
          fileName="reason-event.ics"
          className={CALENDAR_BUTTON}
        />
      )}
      {schedule.data && <YourMeetings schedule={schedule.data} />}
      <Button variant="ghost" size="lg" className="w-full rounded-2xl" onClick={() => navigate(home)}>{homeLabel}</Button>
    </div>
  );
}
