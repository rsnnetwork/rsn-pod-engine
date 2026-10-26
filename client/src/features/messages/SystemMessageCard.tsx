// ─── System message card ─────────────────────────────────────────────────────
//
// A line in the thread that the product wrote, not a person (21 Sep 2026,
// Shradha's deck, P0). Before this, saving availability wrote rows and told
// nobody: "SO HOW DO WE DO THAT, we both have saved our availability?" /
// "I have no clue!!!". Now the chat says what happened and what to do next.
//
// Drawn the SAME for both people — centred, neutral, no avatar, no "seen", no
// reactions — because neither of them wrote it.

import { CalendarCheck, CalendarClock, Clock, Video, Phone } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { isMeetingOver, slotLabel, viewerZone } from './scheduler-flow';
import SheepAvatar from '@/components/brand/SheepAvatar';

export type DmMessageKind = 'user' | 'system';

export type DmSystemMeta =
  | { type: 'availability_shared' }
  | { type: 'meeting_proposal'; slots: string[] }
  | {
      type: 'meeting_confirmed'; startAt: string; durationMin: number;
      meetingType: 'audio' | 'video'; joinPath: string;
      /** Set when this replaced a time that was already agreed. */
      movedFrom?: string;
    };

/** One instant, in the reader's own time zone, in the form the scheduler and the emails use: "Sun 25 Oct, 13:00". */
export function localWhen(iso: string): string {
  if (isNaN(Date.parse(iso))) return iso;
  return slotLabel(iso, viewerZone());
}

interface Props {
  content: string;
  meta?: DmSystemMeta | null;
  /** The times both still share, from the scheduler, so a proposal card never
   *  offers a time that has since been taken off the table. Undefined until
   *  the scheduling has loaded; the card's own stored times stand in till then. */
  liveSlots?: string[];
  /** A time on a proposal card: opens the scheduler on that time's confirm
   *  card (26 Oct 2026; it used to drop the time and only open the panel). */
  onPickSlot?: (slot: string) => void;
  onOpenScheduler?: () => void;
  /** Hidden once a meeting is set: the proposal has been answered. */
  meetingConfirmed?: boolean;
  onAddToCalendar?: () => void;
  /** Ring them instead, once the meeting's own time has passed. Only offered
   *  when calls are unlocked — the first meeting is what unlocks them. */
  onCallNow?: (kind: 'audio' | 'video') => void;
  callsUnlocked?: boolean;
  /** The thread's current meeting has ended. A card can also be over on its
   *  own terms (an older meeting under a newer one); either makes it over. */
  meetingOver?: boolean;
  /** The thread's meeting as it stands now, once the scheduling has loaded
   *  (null: none stands, it was cancelled). A card for another time is history. */
  currentMeeting?: { startAt: string | null } | null;
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Date.parse(a) === Date.parse(b);

export default function SystemMessageCard({
  content, meta, liveSlots, onPickSlot, onOpenScheduler, meetingConfirmed, onAddToCalendar,
  onCallNow, callsUnlocked, meetingOver, currentMeeting,
}: Props) {
  const navigate = useNavigate();

  if (meta?.type === 'meeting_confirmed') {
    // The card outlives the meeting it announces. While the time is still
    // ahead (plus the grace period) it is the way in; afterwards there is no
    // room to join, so it offers the call instead — the same two states the
    // pinned banner has had since 8 Sep 2026. The banner reads the thread's
    // current meeting and the card carries its own; a card must never offer a
    // way in while the banner above it says the meeting ended, so either one
    // being over settles it.
    const over = !!meetingOver || isMeetingOver(meta.startAt, meta.durationMin);
    // 26 Oct 2026: a meeting can be moved (Reschedule) or cancelled. The card
    // for a time that no longer stands says so and offers nothing to press;
    // its Join used to open the room for a time nobody was keeping.
    const replaced = !over && currentMeeting !== undefined && !(currentMeeting && sameInstant(currentMeeting.startAt, meta.startAt));
    const settled = over || replaced;
    return (
      // The deck puts the sheep in message threads, matched pose, on exactly
      // this moment: "MATCHED - match found; meeting confirmed in the chat."
      // Once the meeting is behind them it is a record, not a celebration, so
      // the calendar tick comes back.
      <Shell
        tone="confirmed"
        icon={settled
          ? <CalendarCheck className="h-4 w-4 text-emerald-600" />
          : <SheepAvatar pose="matched" size={44} />}
      >
        <p className="text-sm font-semibold text-emerald-800">
          {meta.movedFrom ? 'Meeting moved' : 'Meeting confirmed'}
        </p>
        <p className="text-sm text-emerald-900">{localWhen(meta.startAt)}</p>
        {meta.movedFrom && (
          <p className="text-[11px] text-emerald-700 line-through decoration-emerald-400">
            {localWhen(meta.movedFrom)}
          </p>
        )}
        <p className="text-[11px] text-emerald-700">
          {meta.durationMin} minutes · {meta.meetingType === 'audio' ? 'Audio call' : 'Video call'} · your local time
        </p>
        {replaced && (
          <p className="mt-1 text-[11px] font-medium text-gray-700" data-testid="meeting-card-replaced">
            {currentMeeting === null ? 'This meeting was cancelled.' : 'This meeting moved to another time.'}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap justify-center gap-2">
          {!settled && (
            <button
              type="button"
              onClick={() => navigate(meta.joinPath)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {meta.meetingType === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join meeting
            </button>
          )}
          {over && callsUnlocked && onCallNow && (
            <button
              type="button"
              onClick={() => onCallNow(meta.meetingType)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {meta.meetingType === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Call now
            </button>
          )}
          {onAddToCalendar && !settled && (
            <button
              type="button"
              onClick={onAddToCalendar}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
            >
              <CalendarCheck className="h-4 w-4" /> Add to calendar
            </button>
          )}
        </div>
      </Shell>
    );
  }

  if (meta?.type === 'meeting_proposal') {
    // Once a meeting is set the card has served its purpose; leave the text so
    // the history still reads, but drop the times nobody should pick any more.
    // The same for a time that has started, or that one of them took back.
    // data-scheduler-trigger: these buttons open or point the scheduler, so the
    // panel's "tap outside closes it" must not treat them as outside.
    const slots = (liveSlots ?? meta.slots).filter(s => Date.parse(s) > Date.now()).slice(0, 3);
    return (
      <Shell tone="proposal" icon={<Clock className="h-4 w-4 text-emerald-600" />}>
        <p className="text-sm text-[#1a1a2e]">You are both free. Pick one to confirm.</p>
        {!meetingConfirmed && (slots.length > 0 || onOpenScheduler) && (
          <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
            {slots.map(s => (
              <button
                key={s}
                type="button"
                data-scheduler-trigger
                onClick={() => onPickSlot?.(s)}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
              >
                {localWhen(s)}
              </button>
            ))}
            {onOpenScheduler && (
              <button
                type="button"
                data-scheduler-trigger
                onClick={onOpenScheduler}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
              >
                See all times
              </button>
            )}
          </div>
        )}
      </Shell>
    );
  }

  // availability_shared, and any card kind an older client does not know yet.
  return (
    <Shell tone="plain" icon={<CalendarClock className="h-4 w-4 text-gray-400" />}>
      <p className="text-sm text-[#1a1a2e]">{content}</p>
      {meta?.type === 'availability_shared' && onOpenScheduler && (
        <div className="mt-1.5 flex justify-center">
          <button
            type="button"
            data-scheduler-trigger
            onClick={onOpenScheduler}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Add my times
          </button>
        </div>
      )}
    </Shell>
  );
}

function Shell({ tone, icon, children }: { tone: 'plain' | 'proposal' | 'confirmed'; icon: React.ReactNode; children: React.ReactNode }) {
  const skin = tone === 'confirmed'
    ? 'border-emerald-200 bg-emerald-50'
    : tone === 'proposal'
      ? 'border-emerald-200 bg-white'
      : 'border-gray-200 bg-white';
  return (
    <div className="flex justify-center py-2">
      <div className={`max-w-[85%] rounded-xl border px-3 py-2.5 text-center ${skin}`} data-testid="system-message-card">
        <div className="mb-1 flex justify-center">{icon}</div>
        {children}
      </div>
    </div>
  );
}
