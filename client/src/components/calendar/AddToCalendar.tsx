// "Add to calendar" (1 Nov 2026, T7, L10): one button opening a menu of Google Calendar, Outlook.com and a .ics file
// for Apple Calendar or any other. It reverses the 9 Sep "file only" rule: a downloaded file goes nowhere for a Google
// Calendar user on a phone. Used by the meeting page, the thread's "Meeting confirmed" card, the scheduler and the
// event page. On a phone the menu is the REASON Sheet; from 768px it opens beside the button.
//
// 11 Nov 2026 (Shirley Palmer's RSN 09): the calendar file comes FIRST (no sign-in, and it updates the emailed
// invitation instead of adding a second entry), then Google and Outlook.com, each saying it opens another site that may
// ask to sign in. When the invitation was emailed (`emailed`), the button is "Add manually": an optional, secondary step,
// and the menu says adding it again may make a second entry. Each caller gives it a quiet look in that case.
// - The two links are plain <a target="_blank"> pressed by the person, so a popup blocker lets them through.
// - The file is fetched (or built) on the press, saved through an object URL that is kept for a minute: WebKit starts
//   a blob download after the click returns, and revoking it on the same tick could leave no download at all.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarPlus, Download } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { errorMessage } from '@/features/reason/errors';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { calendarLinks, type CalendarEntry } from './calendar-links';
import {
  ADD_MANUALLY, ADD_TO_CALENDAR, EMAILED_NOTE, GOOGLE_NOTE, ICS_OPTION, NOT_EMAILED_NOTE, OUTLOOK_NOTE, icsNote,
} from './invite-words';

const KEEP_FILE_MS = 60_000;
const MENU_WIDTH = 300;
const OPTION = 'flex min-h-[44px] w-full items-center gap-3 rounded-[11px] px-3 py-1.5 text-left text-[14px] font-semibold text-reason-ink hover:bg-[#f5f6f7] focus-visible:bg-[#f5f6f7]';
const NOTE = 'block text-[12px] font-normal leading-snug text-reason-muted';

interface Props {
  /** What the Google and Outlook.com links fill in. */
  entry: CalendarEntry;
  /** The .ics, fetched or built when it is asked for. */
  file: () => Promise<Blob | string>;
  fileName?: string;
  /** The button's own look, so each place keeps its style. */
  className?: string;
  icon?: ReactNode;
  /** The calendar invitation was (or is being) emailed: the button is "Add manually" and the menu says it is optional. */
  emailed?: boolean;
}

export default function AddToCalendar({ entry, file, fileName = 'reason-meeting.ics', className, icon, emailed = false }: Props) {
  const label = emailed ? ADD_MANUALLY : ADD_TO_CALENDAR;
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const toggle = () => {
    if (open) { close(); return; }
    setWide(window.matchMedia('(min-width: 768px)').matches);
    setOpen(true);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        // The thread scheduler closes on a press outside it; this button (in the panel or on a card) must not be one.
        data-scheduler-trigger
        aria-expanded={open}
        className={className}
      >
        {icon ?? <CalendarPlus aria-hidden="true" className="h-4 w-4" />} {label}
      </button>
      {open && wide && (
        <Popover anchor={trigger} onClose={close}>
          <Options entry={entry} file={file} fileName={fileName} onDone={close} emailed={emailed} />
        </Popover>
      )}
      <Sheet open={open && !wide} onClose={close} title={label}>
        <Options entry={entry} file={file} fileName={fileName} onDone={close} emailed={emailed} />
      </Sheet>
    </>
  );
}

function Options({ entry, file, fileName, onDone, emailed }: { entry: CalendarEntry; file: Props['file']; fileName: string; onDone: () => void; emailed: boolean }) {
  const addToast = useToastStore((s) => s.addToast);
  const [saving, setSaving] = useState(false);
  const links = calendarLinks(entry);

  const saveFile = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const data = await file();
      const url = URL.createObjectURL(new Blob([data], { type: 'text/calendar;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), KEEP_FILE_MS);
      onDone();
    } catch (err) {
      addToast(errorMessage(err, 'We could not make the calendar file. Try again in a moment.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    // data-scheduler-trigger: the thread's scheduler closes on a press outside it, and this menu is portalled out of it.
    <div className="py-2" data-testid="add-to-calendar-menu" data-scheduler-trigger>
      <div role="menu" aria-label={emailed ? ADD_MANUALLY : ADD_TO_CALENDAR} className="grid gap-1">
        <button
          role="menuitem"
          type="button"
          onClick={() => void saveFile()}
          aria-busy={saving || undefined}
          className={cn(OPTION, saving && 'cursor-progress opacity-70')}
          data-testid="calendar-ics"
        >
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#f3f4f6]"><Download className="h-4 w-4" /></span>
          <span className="min-w-0">
            {saving ? 'Preparing the file…' : ICS_OPTION}
            <span className={NOTE}>{icsNote(emailed)}</span>
          </span>
        </button>
        <a role="menuitem" href={links.google} target="_blank" rel="noopener" onClick={onDone} className={OPTION} data-testid="calendar-google">
          <CalendarMark letter="G" />
          <span className="min-w-0">Google Calendar<span className={NOTE}>{GOOGLE_NOTE}</span></span>
        </a>
        <a role="menuitem" href={links.outlook} target="_blank" rel="noopener" onClick={onDone} className={OPTION} data-testid="calendar-outlook">
          <CalendarMark letter="O" />
          <span className="min-w-0">Outlook.com<span className={NOTE}>{OUTLOOK_NOTE}</span></span>
        </a>
      </div>
      <p className="mt-2 px-3 text-[12px] leading-snug text-reason-muted" data-testid="calendar-note">{emailed ? EMAILED_NOTE : NOT_EMAILED_NOTE}</p>
    </div>
  );
}

function CalendarMark({ letter }: { letter: string }) {
  return (
    <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#f3f4f6] text-[13px] font-extrabold text-[#4b5260]">
      {letter}
    </span>
  );
}

/**
 * The menu beside the button from 768px. Portalled to <body> (an ancestor with a transform would trap a fixed box),
 * below the button, or above it when the window has no room under it, and kept inside the window's sides.
 */
function Popover({ anchor, onClose, children }: { anchor: React.RefObject<HTMLButtonElement>; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const button = anchor.current;
    const menu = box.current;
    if (!button || !menu) return;
    const r = button.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = r.bottom + 8;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, r.top - 8 - height);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - MENU_WIDTH - 8);
    setPlace({ top, left });
  }, [anchor]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (box.current?.contains(t) || anchor.current?.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, measure, onClose]);

  return createPortal(
    <div
      ref={box}
      data-scheduler-trigger
      style={{ top: place?.top ?? 0, left: place?.left ?? 0, width: MENU_WIDTH, visibility: place ? 'visible' : 'hidden' }}
      className="fixed z-[200] rounded-2xl border border-reason-line bg-white px-1.5 font-reason shadow-[0_18px_50px_rgba(0,0,0,.16)]"
    >
      {children}
    </div>,
    document.body,
  );
}
