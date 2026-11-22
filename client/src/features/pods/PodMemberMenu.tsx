// ─── The "⋯" menu of a pod member's row (21 Nov 2026) ─────────────────────────────────────────────────────────────
// The director's actions on a member (Make host or Remove host, Remove from pod) moved off the row into one 44px
// button. From 768px it opens a menu beside the button, portalled to <body> so no transformed or clipped ancestor
// (the section's animate-fade-in-up) traps or cuts it, kept inside the window and turned upward when there is no room
// below: focus goes to the first entry, the arrow keys, Home and End move, Escape (anywhere) closes and gives focus back, Tab
// or a tap outside closes. On a phone it opens a bottom sheet (Sheet), as the pod's Manage menu does. An entry runs
// once the menu has closed, so the confirmation it may ask takes focus and gives it back to the button.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';

export interface PodMemberMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  testId: string;
}

const WIDTH = 220;
const GAP = 4;
const EDGE = 8;
const ITEM = 'flex min-h-[48px] w-full items-center rounded-xl px-3 text-left text-[15px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-rsn-red disabled:opacity-50';

interface Place { top: number; left: number }

function afterClose(run: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

export default function PodMemberMenu({ name, items, testId }: { name: string; items: PodMemberMenuItem[]; testId: string }) {
  const wide = useMediaQuery('(min-width: 768px)');
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const triggerId = useId();

  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const height = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - box.bottom - GAP - EDGE;
    const top = height > below && box.top - GAP - EDGE >= height ? box.top - GAP - height : box.bottom + GAP;
    const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
    setPlace({ top, left: Math.max(EDGE, Math.min(box.right - width, window.innerWidth - width - EDGE)) });
  }, []);

  useLayoutEffect(() => {
    if (open && wide) measure();
    if (!open) setPlace(null);
  }, [open, wide, measure]);

  const close = useCallback((giveFocusBack: boolean) => {
    setOpen(false);
    if (giveFocusBack) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open || !wide) return;
    const onOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const focusFirst = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus());
    return () => {
      cancelAnimationFrame(focusFirst);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, wide, close, measure]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') { close(false); return; }
    const entries = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    if (entries.length === 0) return;
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const go: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 };
    if (!(e.key in go)) return;
    e.preventDefault();
    entries[(go[e.key] + entries.length) % entries.length].focus();
  };

  const pick = (item: PodMemberMenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    if (wide) trigger.current?.focus();
    afterClose(item.onSelect);
  };

  if (items.length === 0) return null;

  const entries = (role?: 'menuitem') => items.map((item) => (
    <button
      key={item.key}
      type="button"
      role={role}
      disabled={item.disabled}
      onClick={() => pick(item)}
      data-testid={item.testId}
      className={cn(ITEM, wide && 'min-h-[44px] text-sm', item.danger ? 'text-red-600 hover:bg-red-50' : 'text-[#1a1a2e] hover:bg-gray-50')}
    >
      {item.label}
    </button>
  ));

  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`More for ${name}`}
        aria-haspopup={wide ? 'menu' : 'dialog'}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-rsn-red', open && 'bg-gray-100 text-gray-800')}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
      </button>
      {open && !wide && (
        <Sheet open onClose={() => setOpen(false)} title={name}>
          <div id={menuId} className="grid gap-1 pt-2" data-testid="pod-member-menu">{entries()}</div>
        </Sheet>
      )}
      {open && wide && createPortal(
        <div
          ref={panel}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKey}
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-[70] w-[min(220px,calc(100vw-16px))] rounded-2xl border border-gray-200 bg-white p-1.5 shadow-[0_14px_40px_rgba(16,18,24,.16)]"
          data-testid="pod-member-menu"
        >
          {entries('menuitem')}
        </div>,
        document.body,
      )}
    </>
  );
}
