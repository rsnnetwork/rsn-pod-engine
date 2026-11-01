import type { MessageReplyQuote } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { quoteView } from './reply-text';

// The quote at the top of a reply's bubble (30 Oct 2026, L7), in the one-to-one and the group thread. When the original
// is on the page, tapping the quote brings it into view and marks it for a moment; when it is not (an earlier page not
// yet read), the quote says "Earlier message". A deleted original says "Original message deleted".

/** Brings a message on the page into view, and marks it for a moment so the eye finds it. */
export function jumpToMessage(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('ring-2', 'ring-amber-300', 'rounded-2xl');
  window.setTimeout(() => el.classList.remove('ring-2', 'ring-amber-300', 'rounded-2xl'), 1600);
  return true;
}

export default function ReplyQuote({ quote, loaded, mine }: {
  quote: MessageReplyQuote;
  /** The original is among the messages on the page. */
  loaded: boolean;
  mine: boolean;
}) {
  const view = quoteView(quote, loaded);
  const body = (
    <>
      <span className="block truncate text-[11px] font-semibold text-gray-700">{view.heading}</span>
      {view.text && <span className="block line-clamp-2 break-words text-xs text-gray-600">{view.text}</span>}
    </>
  );
  const look = cn(
    'mb-1 block w-full min-w-0 rounded-lg border-l-[3px] px-2.5 py-1.5 text-left',
    mine ? 'border-gray-400 bg-white/70' : 'border-gray-300 bg-gray-50',
  );
  if (!view.canJump) return <div data-testid="reply-quote" className={look}>{body}</div>;
  return (
    <button
      type="button"
      data-testid="reply-quote"
      onClick={() => jumpToMessage(quote.id)}
      aria-label={`Show the message from ${view.heading}`}
      className={cn(look, 'min-h-[44px] hover:bg-white')}
    >
      {body}
    </button>
  );
}
