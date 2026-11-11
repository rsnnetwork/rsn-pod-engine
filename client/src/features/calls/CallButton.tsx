// client/src/features/calls/CallButton.tsx
// The one "Video call" button (1 Nov 2026, 30 Oct review item 4): a video icon and the words, 44px, shown only
// where the server says the two can call (canCall). Three looks for three places: beside Message on a profile
// (`hero`), in the thread header's row (`icon`, the words as its name and tooltip), and in the phone's More menu
// (`menu`). It only opens the dialog; useCallRequest rings.
// 11 Nov 2026 (Shirley Palmer's RSN 07): never disabled for presence, only while a call of mine is ringing. Someone away
// gets a note under the words (the tooltip on the icon), and a press while they are offline opens the offline sheet.
import { useId } from 'react';
import { Video } from 'lucide-react';
import { cn } from '@/lib/utils';

export const VIDEO_CALL = 'Video call';

interface Props {
  variant: 'hero' | 'icon' | 'menu';
  onClick: () => void;
  /** A call of mine is already ringing: the button waits. Never set for presence. */
  disabled?: boolean;
  /** Its tooltip ("Video call: Bo is away. They'll see your call when they're back."). */
  title?: string;
  /** A line under the words (hero and menu): where the person is, when it matters ("Bo is away. …"). */
  note?: string;
}

const LOOK: Record<Props['variant'], string> = {
  hero: 'inline-flex h-11 min-h-[44px] shrink-0 items-center gap-2 rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold text-reason-ink hover:bg-[#f5f6f7] focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50',
  icon: 'flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-rsn-red disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400',
  menu: 'flex min-h-[44px] w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40',
};

export default function CallButton({ variant, onClick, disabled, title, note }: Props) {
  const noteId = useId();
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? VIDEO_CALL}
      aria-label={variant === 'icon' ? VIDEO_CALL : undefined}
      aria-describedby={note && variant !== 'icon' ? noteId : undefined}
      data-testid="video-call-button"
      className={cn(LOOK[variant])}
    >
      <Video className={variant === 'icon' ? 'h-4.5 w-4.5' : cn('h-4 w-4', variant === 'menu' && 'text-gray-400')} aria-hidden="true" />
      {variant !== 'icon' && VIDEO_CALL}
    </button>
  );
  if (!note || variant === 'icon') return button;
  return (
    <span className={cn('inline-flex flex-col', variant === 'menu' && 'w-full')}>
      {button}
      <span id={noteId} className={cn('text-[12px] text-amber-700', variant === 'menu' ? 'px-4 pb-2' : 'mt-1 max-w-[260px]')} data-testid="video-call-note">
        {note}
      </span>
    </span>
  );
}
