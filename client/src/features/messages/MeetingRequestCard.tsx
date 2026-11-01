// One meeting request, drawn the same way in the list above the inbox and in the focused pane the
// bell opens (30 Oct 2026). Stefan: "Text overlaps on the connection request card" and "It looks like
// the sender wrote it". So the card says, in REASON's voice, "Shradha wants to meet you"; under it is the
// person; then what they wrote, under "Shradha's note", as a quote; then REASON's own line in its own
// muted box. No tap box reaches over another line: the name and "View full profile" are their own 44px
// rows, and every text wraps inside the card ([overflow-wrap:anywhere]) however long a name or a word is.

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, X } from 'lucide-react';
import { MEETING_FORMATS } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import ProfileLink from '@/components/ui/ProfileLink';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import ReasonLineBox from './ReasonLineBox';
import { useRequestAnswer } from './useRequestAnswer';

export interface PendingRequest {
  id: string;
  senderId: string;
  /** The note and REASON's line run together: what servers before 30 Oct 2026 send, and the fallback. */
  message: string | null;
  /** What the member wrote, and REASON's own line, apart (30 Oct 2026). */
  note?: string | null;
  reasonLine?: string | null;
  createdAt: string;
  senderFirstName?: string | null;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  senderJobTitle: string | null;
  senderCompany: string | null;
  preferredFormat?: 'video_20' | 'coffee' | 'message_first' | null;
}

const formatLabel = (f: PendingRequest['preferredFormat']) => MEETING_FORMATS.find(m => m.key === f)?.label ?? null;

/** "Shradha": the first name, else the first word of the name, so the heading never reads "null wants to meet you". */
export function senderFirst(r: Pick<PendingRequest, 'senderFirstName' | 'senderDisplayName'>): string {
  return r.senderFirstName?.trim() || r.senderDisplayName?.trim().split(/\s+/)[0] || 'A member';
}

/**
 * Accept and Decline for one request (26 Oct 2026). Both forms of the card draw this, and the bell
 * answers through the same hook: one mutation key per request, so while any of them is answering it,
 * every one of them is busy and none offers a second answer. Accepting lands in the conversation (a
 * repeated accept too: the server answers with the same one).
 */
export function RequestAnswerButtons({ requestId, className, onDeclined }: {
  requestId: string; className: string; onDeclined?: () => void;
}) {
  const navigate = useNavigate();
  const addToast = useToastStore(s => s.addToast);
  const { answer, busy, answering } = useRequestAnswer(requestId, {
    onAccepted: (result) => {
      addToast('Connected — say hello', 'success');
      if (result.conversationId) navigate(`/messages/${result.conversationId}`);
    },
    onDeclined,
  });
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => answer('accept')}
        disabled={busy}
        className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-rsn-red px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {answering === 'accept' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Accept
      </button>
      <button
        type="button"
        onClick={() => answer('decline')}
        disabled={busy}
        className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
      >
        {answering === 'decline' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Decline
      </button>
    </div>
  );
}

// The number in the line-clamp-6 class below. Tailwind needs that class written out in full, so the
// two are kept equal by hand.
const NOTE_LINES = 6;

/**
 * A note in the list form: six lines, and "Show more" under it ONLY while the text really is cut off
 * (5 Oct 2026). The focused card is not shown below 1024px, so on a phone this is the only place a
 * long note can be read before accepting. The text is measured, not guessed: how many lines it takes
 * depends on the width and the font, so it is measured again on resize and once fonts load. The button
 * is its own 44px row under the note, its focus ring drawn inside it, so it overlaps no text.
 */
function ClampedNote({ text }: { text: string }) {
  const id = useId();
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cutOff, setCutOff] = useState(false);

  useLayoutEffect(() => {
    const paragraph = paragraphRef.current;
    if (!paragraph) return;
    let stale = false;
    const measure = () => {
      if (stale) return;
      const style = getComputedStyle(paragraph);
      const parsed = parseFloat(style.lineHeight);
      const lineHeight = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.2;
      setCutOff(paragraph.scrollHeight > lineHeight * NOTE_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    void document.fonts?.ready.then(measure);
    return () => {
      stale = true;
      observer.disconnect();
    };
  }, [text]);

  return (
    <>
      <p id={id} ref={paragraphRef} className={cn(NOTE_TEXT, !expanded && 'line-clamp-6')}>{text}</p>
      {cutOff && (
        <button
          type="button"
          onClick={() => setExpanded(open => !open)}
          aria-expanded={expanded}
          aria-controls={id}
          className="flex min-h-[44px] w-fit min-w-[44px] items-center text-xs font-medium text-rsn-red underline underline-offset-2 hover:text-rsn-red-hover focus-visible:ring-inset focus-visible:ring-offset-0"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

const NOTE_TEXT = 'whitespace-pre-line text-sm text-gray-700 [overflow-wrap:anywhere]';

/**
 * The two texts to draw. A server from before 30 Oct 2026 sends only `message`, the two run together:
 * it is shown as it always was, as plain text with no "note" heading, because part of it may be REASON's.
 */
function textsOf(r: PendingRequest): { note: string | null; reasonLine: string | null; plain: string | null } {
  if (r.note !== undefined || r.reasonLine !== undefined) {
    return { note: r.note?.trim() || null, reasonLine: r.reasonLine?.trim() || null, plain: null };
  }
  return { note: null, reasonLine: null, plain: r.message?.trim() || null };
}

interface CardProps {
  request: PendingRequest;
  variant: 'list' | 'focused';
  /** The list form rings the request the bell pointed at. */
  highlighted?: boolean;
  onDeclined?: () => void;
}

export default function MeetingRequestCard({ request: r, variant, highlighted, onDeclined }: CardProps) {
  const first = senderFirst(r);
  const name = r.senderDisplayName || 'A member';
  const role = [r.senderJobTitle, r.senderCompany].filter(Boolean).join(' · ');
  const { note, reasonLine, plain } = textsOf(r);
  const prefers = formatLabel(r.preferredFormat);
  const focused = variant === 'focused';
  const profileTitle = `View ${r.senderDisplayName || 'this member'}'s profile`;

  return (
    <article
      data-testid={focused ? 'focused-meeting-request' : 'meeting-request'}
      data-sender-id={r.senderId}
      data-poke-id={r.id}
      className={cn(
        'min-w-0 rounded-xl border bg-white',
        focused ? 'w-full max-w-md rounded-2xl border-rsn-red/30 p-5 shadow-sm sm:p-6' : 'p-3 transition-shadow',
        !focused && (highlighted ? 'border-rsn-red ring-2 ring-rsn-red/40' : 'border-rsn-red/20'),
      )}
    >
      {focused && <p className="text-xs font-semibold uppercase tracking-wider text-rsn-red">Meeting request</p>}
      <h3 data-part="heading" className={cn('font-bold text-[#1a1a2e] [overflow-wrap:anywhere]', focused ? 'mt-2 text-lg' : 'text-sm')}>
        {first} wants to meet you
      </h3>

      {/* The person: the avatar and the name each open their profile, in the same tab (26 Oct 2026). */}
      <div className="mt-2 flex min-w-0 items-center gap-3">
        <ProfileLink from="Messages" userId={r.senderId} title={profileTitle} className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center">
          <Avatar src={r.senderAvatarUrl || undefined} name={name} size={focused ? 'lg' : 'md'} />
        </ProfileLink>
        <div className="min-w-0 flex-1">
          <ProfileLink
            from="Messages"
            userId={r.senderId}
            title={profileTitle}
            className="flex min-h-[44px] items-center text-sm font-semibold text-[#1a1a2e] [overflow-wrap:anywhere] hover:text-rsn-red hover:underline"
          >
            <span data-part="name">{name}</span>
          </ProfileLink>
          {role && <p data-part="role" className="text-xs text-gray-500 [overflow-wrap:anywhere]">{role}</p>}
        </div>
      </div>

      {note && (
        <div className="mt-3" data-part="note">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 [overflow-wrap:anywhere]">{first}&rsquo;s note</p>
          <blockquote className="mt-1 border-l-2 border-rsn-red/40 pl-3">
            {focused ? <p className={NOTE_TEXT}>{note}</p> : <ClampedNote text={note} />}
          </blockquote>
        </div>
      )}
      {plain && (
        <div className="mt-3" data-part="message">
          {focused ? <p className={NOTE_TEXT}>{plain}</p> : <ClampedNote text={plain} />}
        </div>
      )}
      {reasonLine && <ReasonLineBox line={reasonLine} className="mt-3" />}
      {prefers && <p data-part="prefers" className="mt-2 text-xs text-gray-500 [overflow-wrap:anywhere]">Prefers {prefers.toLowerCase()}</p>}

      {focused && (
        <ProfileLink
          from="Messages"
          userId={r.senderId}
          className="mt-1 flex min-h-[44px] w-fit items-center text-xs font-medium text-rsn-red underline"
        >
          View full profile
        </ProfileLink>
      )}
      <RequestAnswerButtons requestId={r.id} className={cn('flex gap-2', focused ? 'mt-4' : 'mt-3')} onDeclined={onDeclined} />
    </article>
  );
}
