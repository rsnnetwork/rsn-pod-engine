// Bottom sheet on phones, centred dialog from 768px. Portalled to <body>: an
// ancestor with a transform (animate-fade-in-up) would otherwise trap a fixed
// overlay inside it (memory: Modal/Overlay Portal Trap).
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Sheets can stack (a confirmation over a form). Only the top one answers the
// keyboard: two focus traps would otherwise keep pulling focus back to the
// first control, so Tab could never get past it.
const openPanels: HTMLElement[] = [];
// The page's scroll lock belongs to the stack, not to one sheet: the first sheet to open
// locks the page and remembers what it had, the last one to close gives that back. A sheet
// that saved and restored it for itself broke when the first closed before the second: it
// put the old value back under the sheet still open, and the second then put back the
// 'hidden' it had seen, so the page stayed locked.
let overflowBeforeLock = '';
// WebKit does not focus a button or a link when it is clicked or tapped, so a sheet opened that way finds <body>
// as the active element and focus has nowhere to go back to when it closes. The control pressed last stands in.
let lastPressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    lastPressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a, [tabindex]') : null;
  }, { capture: true, passive: true });
}

export default function Sheet({ open, onClose, title, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  // Parents pass inline arrows. Reading the latest one through a ref keeps the
  // effect below from re-running (and stealing focus) on every parent render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  // A press that starts inside the panel (selecting text) and is released on
  // the backdrop is not a tap on the backdrop, yet the browser clicks the
  // overlay, their common ancestor. Where the press began is checked as well.
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = panel.current;
    if (!open || !dialog) return;
    // Where focus goes back to when the sheet closes. A keyboard opener, and any click in Chromium, is the active
    // element; when nothing has focus (WebKit after a click or a tap) the control pressed last is the opener.
    const active = document.activeElement as HTMLElement | null;
    const opener = (!active || active === document.body) && lastPressed?.isConnected ? lastPressed : active;
    if (openPanels.length === 0) {
      overflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openPanels.push(dialog);
    const onKey = (e: KeyboardEvent) => {
      if (openPanels[openPanels.length - 1] !== dialog) return;
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      if (!stops.length) { e.preventDefault(); dialog.focus(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const current = document.activeElement;
      // Wrap at both ends. The panel itself takes focus on open, so Shift+Tab
      // from it must wrap too (it would leave through the top), and so must a
      // Tab from anywhere outside the dialog.
      if (!dialog.contains(current) || (e.shiftKey && (current === first || current === dialog))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    // The dialog itself takes focus, not a field: a focused field opens the
    // phone keyboard over the sheet before the member has read it.
    dialog.focus();
    return () => {
      const at = openPanels.lastIndexOf(dialog);
      if (at !== -1) openPanels.splice(at, 1);
      if (openPanels.length === 0) document.body.style.overflow = overflowBeforeLock;
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  // React bubbles events from a portal to the ancestors of <Sheet>, so a card
  // that wraps a sheet would take every press made inside it. The overlay stops
  // them here.
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-[rgba(12,14,18,.45)] font-reason text-reason-ink md:items-center md:p-6"
      onPointerDown={(e) => { e.stopPropagation(); pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation();
        const tappedBackdrop = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (tappedBackdrop) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90dvh] w-full flex-col rounded-t-[20px] bg-white shadow-[0_30px_80px_rgba(0,0,0,.18)] outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:max-h-[86dvh] md:w-[min(560px,100%)] md:rounded-[20px]"
      >
        <div className="flex items-center justify-between gap-3 px-[15px] pt-[18px] md:px-5 md:pt-5">
          <h2 className="min-w-0 text-[20px] font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#f3f4f6]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={cn('overflow-y-auto px-[15px] md:px-5', footer ? 'pb-3' : 'pb-[calc(12px+env(safe-area-inset-bottom))]')}>{children}</div>
        {footer && (
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-reason-line bg-white px-[15px] pt-2.5 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
