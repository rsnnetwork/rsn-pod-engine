// client/src/features/meetings/MeetingCard.tsx
// One meeting under Events: who, when (the reader's own time, the zone named), the first line of why, its chip, and
// what can be done now: Join, or when it starts, and the chat. The whole card opens the meeting's page; Join and the
// chat sit above that link.
import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { Meeting } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { ACTION, CARD_FRAME, JoinOrCountdown, PhaseChip } from './MeetingParts';
import { firstLine, meetingChip, meetingLine } from './meeting-words';

export default function MeetingCard({ meeting, now }: { meeting: Meeting; now: number }) {
  const headingId = useId();
  const name = meeting.partner.displayName;
  const chip = meetingChip(meeting, now);
  const why = firstLine(meeting.context);
  const over = meeting.status === 'cancelled' || chip === 'Ended';

  return (
    <article
      data-meeting-id={meeting.id}
      aria-labelledby={headingId}
      className={cn(
        CARD_FRAME,
        'relative transition-colors [container-type:inline-size] hover:border-[#d5d8de] hover:bg-reason-soft',
        over && 'bg-reason-soft',
      )}
    >
      <div className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-3">
        <Avatar src={meeting.partner.avatarUrl} name={name} size="lg" className={cn('h-12 w-12 rounded-xl', over && 'opacity-70')} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={headingId} className="min-w-0 text-[16px] font-bold leading-tight [overflow-wrap:anywhere]">
              {/* Stretched over the card, so a tap anywhere on it opens the meeting's page. */}
              <Link to={`/meetings/${encodeURIComponent(meeting.id)}`} className="after:absolute after:inset-0 after:rounded-[15px] after:content-[''] hover:underline">
                Meeting with {name}
              </Link>
            </h3>
            {chip && <PhaseChip chip={chip} />}
          </div>
          <p className="mt-1 text-[13px] text-[#4b5260]">{meetingLine(meeting)}</p>
          {why && <p className="mt-1 line-clamp-2 text-[13px] text-reason-muted [overflow-wrap:anywhere]">“{why}”</p>}
        </div>
      </div>
      {/* Sized to the card, not the window (a container query): a card as narrow as a phone's (half a row from 1024px)
          shares its row between the two buttons; a wide one lines them up under the text. At the card's foot, so two
          cards side by side, or one card filling the list's room, keep their buttons on one line. */}
      <div className="relative z-[1] mt-auto flex flex-wrap gap-2 [@container(min-width:26rem)]:pl-[60px]">
        <JoinOrCountdown meeting={meeting} now={now} label={`Join the meeting with ${name}`} className="flex-1 [@container(min-width:26rem)]:flex-none" />
        <Link
          to={`/messages/${encodeURIComponent(meeting.conversationId)}`}
          aria-label={`Open chat with ${name}`}
          className={cn(ACTION, 'flex-1 border border-reason-line bg-white text-[#2d3440] hover:bg-[#f5f6f7] [@container(min-width:26rem)]:flex-none')}
        >
          Open chat
        </Link>
      </div>
    </article>
  );
}
