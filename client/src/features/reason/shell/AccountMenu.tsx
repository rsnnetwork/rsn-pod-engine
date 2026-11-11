// client/src/features/reason/shell/AccountMenu.tsx
// The top bar's photo (Shirley pilot S6, RSN 13: "clicking the top right profile image had no response"; it was a link
// to /profile, so on /profile nothing happened). It opens the account menu: View profile, Preview as others see it,
// Copy link, Edit profile, Settings, Log out, the same on a phone and on a desktop.
//
// A plain disclosure, like the sidebar's ProfileMenu: a button that shows and hides links and buttons, not a menu in the
// ARIA sense, so no menu roles. The panel is portalled to <body> (an ancestor with a transform or an overflow would trap
// or clip a fixed panel: the Modal/Overlay Portal Trap) and placed under the photo, right edges aligned, inside the
// window at 360px. Every row is at least 44px. Open, focus moves to its first row; Tab and Shift+Tab stay inside it;
// Escape closes it and gives focus back to the photo; a tap outside it, or a page change, closes it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { PREVIEW_TO } from '../profile/share-text';
import { useCopyMemberLink } from '../profile/useCopyLink';
import LogoutSheet from './LogoutSheet';

const ROW = 'flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-[14px] hover:bg-reason-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red';
const ITEMS = 'a[href], button:not([disabled])';
/** The gap between the photo and the panel, and the least margin the panel keeps from the window's edges. */
const GAP = 6;
const EDGE = 8;

interface Place { top: number; right: number; maxHeight: number }

export default function AccountMenu() {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const copyMemberLink = useCopyMemberLink();

  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const top = box.bottom + GAP;
    setPlace({
      top,
      right: Math.max(EDGE, window.innerWidth - box.right),
      maxHeight: Math.max(160, window.innerHeight - top - EDGE),
    });
  }, []);

  // Placed before the browser paints, so the panel never flashes at the window's corner.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // A page change (a row followed, Back pressed) closes it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const close = useCallback((giveFocusBack: boolean) => {
    setOpen(false);
    if (giveFocusBack) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const rows = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = rows();
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !panel.current?.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !panel.current?.contains(current))) {
        e.preventDefault();
        first.focus();
      }
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
  }, [open, close, measure]);

  if (!user) return null;
  const name = user.displayName || 'You';

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label="Account menu"
        className={cn('grid h-11 w-11 place-items-center rounded-xl border bg-white', open ? 'border-reason-red' : 'border-reason-line')}
        data-testid="account-menu-trigger"
      >
        <Avatar src={user.avatarUrl} name={name} size="sm" />
      </button>
      {open && place && createPortal(
        <div
          ref={panel}
          id={panelId}
          aria-label="Account menu"
          role="group"
          style={{ top: place.top, right: place.right, maxHeight: place.maxHeight }}
          className="fixed z-[70] w-[min(280px,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-2xl border border-reason-line bg-white p-1.5 font-reason text-reason-ink shadow-[0_14px_40px_rgba(16,18,24,.16)]"
          data-testid="account-menu"
        >
          <div className="flex items-center gap-2.5 px-3 pb-2 pt-1.5">
            <Avatar src={user.avatarUrl} name={name} size="sm" />
            <strong className="min-w-0 truncate text-[14px]">{name}</strong>
          </div>
          <div className="grid border-t border-reason-line pt-1.5">
            <Link to="/profile" onClick={() => close(false)} className={ROW}>View profile</Link>
            <Link to={PREVIEW_TO} onClick={() => close(false)} className={ROW}>Preview as others see it</Link>
            <button type="button" onClick={() => { close(true); void copyMemberLink(); }} className={ROW}>Copy link</button>
            <Link to="/profile/edit" onClick={() => close(false)} className={ROW}>Edit profile</Link>
            <Link to="/settings" onClick={() => close(false)} className={ROW}>Settings</Link>
            <button
              type="button"
              onClick={() => { close(false); setConfirm(true); }}
              className={cn(ROW, 'text-reason-red-hover')}
            >
              Log out
            </button>
          </div>
        </div>,
        document.body,
      )}
      <LogoutSheet open={confirm} onClose={() => { setConfirm(false); trigger.current?.focus(); }} />
    </>
  );
}
