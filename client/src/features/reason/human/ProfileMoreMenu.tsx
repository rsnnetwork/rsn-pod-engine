// client/src/features/reason/human/ProfileMoreMenu.tsx
// "More" in the Human Profile's header (21 Oct 2026): Block and Report this member, the two things the old public
// profile offered beyond meeting, so nothing is lost when every people link opens this page. The page owns what
// they do (the old page's confirmation, its block call and its report dialog); this only offers them.
//
// A plain disclosure, like the account menu: a button that shows and hides two buttons. It is not a menu in the
// ARIA sense (that role promises arrow keys), so no menu roles. It closes on Escape or a tap outside it.
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ReasonIcon } from '../ui/icons';

const ITEM = 'flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-[14px] hover:bg-reason-soft';

interface Props {
  onBlock: () => void;
  onReport: () => void;
  /** A block is on its way: Block cannot be pressed again until it has an answer. */
  blocking: boolean;
}

export default function ProfileMoreMenu({ onBlock, onReport, blocking }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onOutside = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [open]);

  const choose = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="More"
        className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-full border border-reason-line bg-white px-2.5 text-[13px] font-extrabold sm:px-3.5"
      >
        <ReasonIcon name="more" width={20} height={20} />
        <span className="hidden sm:inline">More</span>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[220px] rounded-2xl border border-reason-line bg-white p-1.5 shadow-[0_14px_40px_rgba(16,18,24,.12)]">
          <button
            type="button"
            onClick={choose(onBlock)}
            disabled={blocking}
            className={cn(ITEM, 'font-bold text-reason-red-hover disabled:cursor-default disabled:opacity-60')}
          >Block</button>
          <button type="button" onClick={choose(onReport)} className={ITEM}>Report this member</button>
        </div>
      )}
    </div>
  );
}
