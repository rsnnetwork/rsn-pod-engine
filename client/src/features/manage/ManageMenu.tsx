// ─── The Manage button and its menu (Shirley pilot S3, 11 Nov 2026; brief RSN 11) ────────────────────────────────
// One button, "Manage", on a circle's or a pod's page, for whoever runs it; the entries are the page's (manage-menu.ts
// decides which). On a phone (under 768px) the entries open as a bottom sheet (Sheet: portalled to <body>, Escape and a
// tap outside close it, focus stays inside and goes back to the button). From 768px they open as a menu under the
// button: a disclosure, portalled to <body> so no transformed or clipped ancestor traps it, kept inside the window,
// with the same keyboard rules as the account menu (focus on the first entry, Tab wraps, Escape closes and gives focus
// back, a tap outside or a page change closes it). Every entry is at least 48px tall. With no entries there is no button.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { MANAGE, MANAGE_LABEL, type ManageKey } from './manage-menu';

export interface ManageEntry {
  key: ManageKey;
  hint?: string;
  onSelect: () => void;
  /** The entry's test id; `manage-<key>` when not given. */
  testId?: string;
}

interface Props {
  /** What the sheet and the menu are called, e.g. "Manage Curious Humans". */
  title: string;
  entries: ManageEntry[];
  className?: string;
}

const ENTRY = 'flex min-h-[48px] w-full flex-col items-start justify-center rounded-xl px-3 py-2 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rsn-red';
const ITEMS = 'button:not([disabled])';
const GAP = 6;
const EDGE = 8;
const WIDTH = 300;

interface Place { top: number; left: number; maxHeight: number }

/** An entry that goes to a section of the page brings it to the top of the view. */
export function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Runs an entry once the menu has closed and focus has gone back, so a scroll or a new sheet is not undone by it. */
function afterClose(run: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function Entries({ entries, onPick }: { entries: ManageEntry[]; onPick: (e: ManageEntry) => void }) {
  return (
    <div className="grid gap-0.5">
      {entries.map((e) => (
        <button key={e.key} type="button" onClick={() => onPick(e)} className={ENTRY} data-testid={e.testId ?? `manage-${e.key}`}>
          <span className={cn('text-[15px] font-semibold', e.key === 'archive' ? 'text-red-600' : 'text-[#1a1a2e]')}>{MANAGE_LABEL[e.key]}</span>
          {e.hint && <span className="mt-0.5 text-xs text-gray-500 [overflow-wrap:anywhere]">{e.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export default function ManageMenu({ title, entries, className }: Props) {
  const wide = useMediaQuery('(min-width: 768px)');
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
    const top = box.bottom + GAP;
    setPlace({
      top,
      left: Math.max(EDGE, Math.min(box.left, window.innerWidth - width - EDGE)),
      maxHeight: Math.max(160, window.innerHeight - top - EDGE),
    });
  }, []);

  useLayoutEffect(() => {
    if (open && wide) measure();
  }, [open, wide, measure]);

  // A page change closes it.
  useEffect(() => { setOpen(false); }, [pathname]);

  const close = useCallback((giveFocusBack: boolean) => {
    setOpen(false);
    if (giveFocusBack) trigger.current?.focus();
  }, []);

  // The desktop menu's keyboard and outside-tap rules (the phone's sheet has its own).
  useEffect(() => {
    if (!open || !wide) return;
    const rows = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      if (e.key !== 'Tab') return;
      const stops = rows();
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !panel.current?.contains(current))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (current === last || !panel.current?.contains(current))) { e.preventDefault(); first.focus(); }
    };
    const onOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const focusFirst = requestAnimationFrame(() => rows()[0]?.focus());
    return () => {
      cancelAnimationFrame(focusFirst);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, wide, close, measure]);

  if (entries.length === 0) return null;

  const pick = (e: ManageEntry) => {
    setOpen(false);
    afterClose(e.onSelect);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        data-testid="manage-open"
        className={cn('inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-[#1a1a2e] hover:bg-gray-50', open && 'border-rsn-red', className)}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> {MANAGE}
        <ChevronDown className="h-4 w-4 text-gray-400" aria-hidden="true" />
      </button>
      {open && !wide && (
        <Sheet open onClose={() => setOpen(false)} title={title}>
          <div id={panelId} className="pt-2" data-testid="manage-menu">
            <Entries entries={entries} onPick={pick} />
          </div>
        </Sheet>
      )}
      {open && wide && place && createPortal(
        <div
          ref={panel}
          id={panelId}
          role="group"
          aria-label={title}
          style={{ top: place.top, left: place.left, maxHeight: place.maxHeight }}
          className="fixed z-[70] w-[min(300px,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-2xl border border-gray-200 bg-white p-1.5 shadow-[0_14px_40px_rgba(16,18,24,.16)]"
          data-testid="manage-menu"
        >
          <p className="px-3 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-gray-400 [overflow-wrap:anywhere]">{title}</p>
          <Entries entries={entries} onPick={pick} />
        </div>,
        document.body,
      )}
    </>
  );
}
