// client/src/features/meetings/MeetingParts.tsx
// The two pieces every meeting screen shares: its chip, and Join (open from 5 minutes before the start until 30
// minutes after the end, the server's own rule) or, until then, when it starts.
import { Link } from 'react-router-dom';
import { Clock, Phone, Video } from 'lucide-react';
import { meetingPhase, type Meeting } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { canJoin, startsIn, type MeetingChip } from './meeting-words';

// Each pair clears 4.5:1 for this small bold label: the darker red on pink 5.09:1, green on mint 4.88:1, grey 7.1:1,
// red on rose 6.6:1.
const CHIP_LOOK: Record<MeetingChip, string> = {
  Today: 'bg-reason-pink text-reason-red-hover',
  'Live now': 'bg-[#e9f8f1] text-[#147a4f]',
  Ended: 'bg-[#f1f2f4] text-[#4b5260]',
  Cancelled: 'bg-[#fdecec] text-[#a61b1b]',
};

export function PhaseChip({ chip, className }: { chip: MeetingChip; className?: string }) {
  return (
    // 20px tall, the height of a card's title line, so a chip beside the title never makes the card taller.
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-extrabold leading-4', CHIP_LOOK[chip], className)}>
      {chip === 'Live now' && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#147a4f] motion-safe:animate-pulse" />}
      {chip}
    </span>
  );
}

export const ACTION = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[11px] px-4 text-[14px] font-bold';

/** A meeting card's frame. The list's loading skeleton is drawn in the same one, so it takes the room a card takes. */
export const CARD_FRAME = 'flex flex-col gap-3 rounded-[15px] border border-reason-line bg-white p-3 min-[721px]:p-3.5';

interface JoinProps {
  meeting: Meeting;
  now: number;
  /** The link's accessible name when the page holds more than one meeting ("Join the meeting with Stefan"). */
  label?: string;
  className?: string;
}

/** Join while it is open; before that, when the meeting starts; after it (ended, cancelled), nothing. */
export function JoinOrCountdown({ meeting, now, label, className }: JoinProps) {
  if (canJoin(meeting, now)) {
    const Icon = meeting.kind === 'audio' ? Phone : Video;
    return (
      <Link to={meeting.joinPath} aria-label={label} className={cn(ACTION, 'bg-reason-green-fill text-white hover:bg-reason-green-fill-hover', className)}>
        <Icon aria-hidden="true" className="h-4 w-4" /> Join
      </Link>
    );
  }
  if (meetingPhase(meeting, now) !== 'upcoming') return null;
  // On one line: beside Open chat on a narrow card, the two wrap onto two rows rather than break "2 h 3 min" in half.
  return (
    <p className={cn(ACTION, 'whitespace-nowrap bg-[#f4f5f7] font-semibold text-[#4b5260]', className)}>
      <Clock aria-hidden="true" className="h-4 w-4" /> {startsIn(meeting.startAt, now)}
    </p>
  );
}
