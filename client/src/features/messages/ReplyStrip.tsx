import { CornerUpLeft, X } from 'lucide-react';
import { CANCEL_REPLY, replyingTo, type ReplyTarget } from './reply-text';

// "Replying to Shradha: …" above the message box while a reply is being written (30 Oct 2026, L7), with a 44px cancel.
// One line at every width, so on a 360px phone it never pushes the message box under the bottom bar.
export default function ReplyStrip({ target, onCancel }: { target: ReplyTarget; onCancel: () => void }) {
  return (
    <div data-testid="reply-strip" className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border-l-[3px] border-gray-400 bg-gray-50 pl-2.5">
      <CornerUpLeft className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-xs text-gray-700">{replyingTo(target)}</p>
      <button
        type="button"
        onClick={onCancel}
        aria-label={CANCEL_REPLY}
        title={CANCEL_REPLY}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The Reply beside a message: revealed on hover on a desktop, always there (low) on a touch screen. */
export function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <button
      type="button"
      onClick={onReply}
      aria-label="Reply"
      title="Reply"
      data-testid="reply-button"
      // A screen that can hover (a mouse) shows it on hover or keyboard focus; a touch screen, at any width, always shows
      // it at half strength, since nothing hovers there. The ::after widens the target to 46px without moving the bubble.
      className="relative shrink-0 rounded-full border border-gray-200 bg-white p-1 text-gray-500 opacity-50 shadow-sm transition-opacity after:absolute after:-inset-3 after:content-[''] hover:text-gray-700 hover:!opacity-100 focus-visible:opacity-100 active:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/bubble:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
    >
      <CornerUpLeft className="h-3.5 w-3.5" />
    </button>
  );
}
