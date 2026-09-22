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
import { isMeetingOver } from './MeetingScheduler';
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

/** One instant, in the reader's own timezone. */
export function localWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

interface Props {
  content: string;
  meta?: DmSystemMeta | null;
  /** Live overlap from the scheduler, so a proposal card never offers a time
   *  that has since been taken off the table. Falls back to the stored slots. */
  liveSlots?: string[];
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
}

export default function SystemMessageCard({
  content, meta, liveSlots, onPickSlot, onOpenScheduler, meetingConfirmed, onAddToCalendar,
  onCallNow, callsUnlocked, meetingOver,
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
    return (
      // The deck puts the sheep in message threads, matched pose, on exactly
      // this moment: "MATCHED - match found; meeting confirmed in the chat."
      // Once the meeting is behind them it is a record, not a celebration, so
      // the calendar tick comes back.
      <Shell
        tone="confirmed"
        icon={over
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
        <div className="mt-1.5 flex flex-wrap justify-center gap-2">
          {!over && (
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
          {onAddToCalendar && !over && (
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
    const slots = (liveSlots?.length ? liveSlots : meta.slots).slice(0, 3);
    return (
      <Shell tone="proposal" icon={<Clock className="h-4 w-4 text-emerald-600" />}>
        <p className="text-sm text-[#1a1a2e]">You are both free. Pick one to confirm.</p>
        {!meetingConfirmed && slots.length > 0 && (
          <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
            {slots.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => onPickSlot?.(s)}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
              >
                {localWhen(s)}
              </button>
            ))}
            {onOpenScheduler && (
              <button
                type="button"
                onClick={onOpenScheduler}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-600 hover:bg-gray-50"
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
