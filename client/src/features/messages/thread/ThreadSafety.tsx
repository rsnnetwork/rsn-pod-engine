// client/src/features/messages/thread/ThreadSafety.tsx
// The thread's safety controls (11 Nov 2026, Shirley Palmer's item 16), in words, never a lone icon:
//   - ThreadMoreMenu: the header's "More" menu, at every width. It holds Report member, Block member (or Unblock) and
//     Delete conversation; on a phone also the calls and Find a time, which a wider screen shows in the header row.
//     It closes on a press outside it or Escape.
//   - MessageMoreButton: a "⋯" beside a received message's reaction and reply, whose menu says "Report message".
//   - BlockedThreadBanner: in place of the message box once the member blocked the other person. The conversation
//     stays open and readable; nothing can be sent, and Unblock is right there.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, MoreVertical, ShieldAlert } from 'lucide-react';
import { REPORT_MESSAGE, UNBLOCK, blockedThreadLine } from '@/components/safety/safety-words';

export const MENU_ITEM = 'flex min-h-[44px] w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50';

/** Close on a press outside `box`, or Escape. */
function useDismiss(open: boolean, box: React.RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, box, close]);
}

export function ThreadMoreMenu({ dot, children }: {
  /** The partner changed their availability: a dot on the trigger. */
  dot: boolean;
  /** The items; each is given `close` to call when chosen. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, box, close);
  return (
    <div ref={box} className="relative" data-scheduler-toggle>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={dot ? 'More actions — they updated their availability' : 'More actions'}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="thread-more"
        className="relative flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-gray-500 hover:bg-gray-100"
      >
        <MoreVertical className="h-5 w-5" aria-hidden="true" />
        <span className="hidden text-xs font-medium sm:inline">More</span>
        {dot && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rsn-red ring-2 ring-white" aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-30 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg" data-testid="thread-more-menu">
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** "⋯" beside a message from the other person; its menu reports that message. */
export function MessageMoreButton({ onReport }: { onReport: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, box, close);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions for this message"
        aria-expanded={open}
        aria-haspopup="menu"
        title="More"
        data-testid="message-more"
        // Shown like the reply button: on hover or focus with a mouse, at half strength on a touch screen. The ::after
        // widens the target to 46px without moving the bubble.
        className="relative rounded-full border border-gray-200 bg-white p-1 text-gray-500 opacity-50 shadow-sm transition-opacity after:absolute after:-inset-3 after:content-[''] hover:text-gray-700 hover:!opacity-100 focus-visible:opacity-100 active:!opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/bubble:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-20 mb-1 w-48 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <button type="button" role="menuitem" onClick={() => { close(); onReport(); }} className={MENU_ITEM} data-testid="report-message">
            <ShieldAlert className="h-4 w-4 text-gray-400" aria-hidden="true" /> {REPORT_MESSAGE}
          </button>
        </div>
      )}
    </div>
  );
}

export function BlockedThreadBanner({ name, onUnblock, unblocking }: { name: string | null; onUnblock: () => void; unblocking: boolean }) {
  return (
    <div
      role="status"
      data-testid="blocked-thread"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3 text-sm text-gray-600"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.75rem)' }}
    >
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{blockedThreadLine(name)}</p>
      <button
        type="button"
        onClick={onUnblock}
        disabled={unblocking}
        className="min-h-[44px] shrink-0 rounded-lg border border-gray-200 px-4 font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
      >
        {unblocking ? 'Unblocking…' : UNBLOCK}
      </button>
    </div>
  );
}
