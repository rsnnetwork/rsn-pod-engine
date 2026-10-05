// The sidebar's account block. Holds what the prototype has no slot for but
// members must not lose: Invite, Admin (admins only) and Log out.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import LogoutSheet from './LogoutSheet';

function MenuLink({ to, label, onDone }: { to: string; label: string; onDone: () => void }) {
  return (
    <Link role="menuitem" to={to} onClick={onDone} className="flex min-h-[44px] items-center rounded-xl px-3 text-[14px] hover:bg-reason-soft">
      {label}
    </Link>
  );
}

export default function ProfileMenu() {
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // A menu closes when you press Escape or tap anywhere outside it.
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

  if (!user) return null;
  const name = user.displayName || 'You';
  const close = () => setOpen(false);
  return (
    <div ref={box} className="relative mt-2.5 shrink-0 border-t border-reason-line pt-3.5">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Your account"
        className="flex min-h-[44px] w-full items-center justify-center gap-2.5 rounded-xl px-2 text-left hover:bg-reason-soft min-[981px]:justify-start"
      >
        <Avatar src={user.avatarUrl} name={name} size="md" />
        <span className="hidden min-w-0 flex-1 min-[981px]:block">
          <strong className="block truncate text-[13px]">{name}</strong>
          <span className="block text-[11px] text-reason-muted">View profile</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[220px] rounded-2xl border border-reason-line bg-white p-1.5 shadow-[0_14px_40px_rgba(16,18,24,.12)]">
          <MenuLink to="/profile" label="View profile" onDone={close} />
          <MenuLink to="/invites" label="Invite someone" onDone={close} />
          {isAdmin(user.role) && <MenuLink to="/admin" label="Admin" onDone={close} />}
          <button
            type="button"
            role="menuitem"
            onClick={() => { close(); setConfirm(true); }}
            className="flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-[14px] text-reason-red hover:bg-reason-soft"
          >
            Log out
          </button>
        </div>
      )}
      <LogoutSheet open={confirm} onClose={() => { setConfirm(false); trigger.current?.focus(); }} />
    </div>
  );
}
