// Bottom sheet on phones, centred dialog from 768px. Portalled to <body>: an
// ancestor with a transform (animate-fade-in-up) would otherwise trap a fixed
// overlay inside it (memory: Modal/Overlay Portal Trap).
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }

export default function Sheet({ open, onClose, title, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  // Parents pass inline arrows. Reading the latest one through a ref keeps the
  // effect below from re-running (and stealing focus) on every parent render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    // The dialog itself takes focus, not a field: a focused field opens the
    // phone keyboard over the sheet before the member has read it.
    panel.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-[rgba(12,14,18,.45)] font-reason text-reason-ink md:items-center md:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full flex-col rounded-t-[20px] bg-white shadow-[0_30px_80px_rgba(0,0,0,.18)] outline-none md:max-h-[86vh] md:w-[min(560px,100%)] md:rounded-[20px]"
      >
        <div className="flex items-center justify-between gap-3 px-[15px] pt-[18px] md:px-5 md:pt-5">
          <h2 className="text-[20px] font-bold tracking-[-0.02em]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#f3f4f6]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-[15px] pb-3 md:px-5">{children}</div>
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
