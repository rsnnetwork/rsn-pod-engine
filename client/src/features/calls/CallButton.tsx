// client/src/features/calls/CallButton.tsx
// The one "Video call" button (1 Nov 2026, 30 Oct review item 4): a video icon and the words, 44px, shown only
// where the server says the two can call (canCall). Three looks for three places: beside Message on a profile
// (`hero`), in the thread header's row (`icon`, the words as its name and tooltip), and in the phone's More menu
// (`menu`). It only opens the dialog; useCallRequest rings.
import { Video } from 'lucide-react';
import { cn } from '@/lib/utils';

export const VIDEO_CALL = 'Video call';

interface Props {
  variant: 'hero' | 'icon' | 'menu';
  onClick: () => void;
  /** A call is already ringing, or the other person is known to be away: the button waits. */
  disabled?: boolean;
  /** Why it waits, said as its tooltip ("Bo is offline"). */
  title?: string;
}

const LOOK: Record<Props['variant'], string> = {
  hero: 'inline-flex min-h-[44px] items-center gap-2 rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold text-reason-ink hover:bg-[#f5f6f7] focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50',
  icon: 'flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-rsn-red disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400',
  menu: 'flex min-h-[44px] w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40',
};

export default function CallButton({ variant, onClick, disabled, title }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? VIDEO_CALL}
      aria-label={variant === 'icon' ? VIDEO_CALL : undefined}
      data-testid="video-call-button"
      className={cn(LOOK[variant])}
    >
      <Video className={variant === 'icon' ? 'h-4.5 w-4.5' : cn('h-4 w-4', variant === 'menu' && 'text-gray-400')} aria-hidden="true" />
      {variant !== 'icon' && VIDEO_CALL}
    </button>
  );
}
