// The old layout listed the Admin sections under "Admin" whenever an admin was on
// one of them. The new sidebar has no such slot, and Support tickets was linked
// from nowhere else, so the sections sit under one row of tabs on every Admin page.
import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import useRevealActive from './useRevealActive';

export const ADMIN_TABS = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/analytics', label: 'Analytics', end: false },
  { to: '/admin/users', label: 'Users', end: false },
  { to: '/admin/pods', label: 'Pods', end: false },
  { to: '/admin/sessions', label: 'Events', end: false },
  { to: '/admin/join-requests', label: 'Join Requests', end: false },
  { to: '/admin/moderation', label: 'Moderation', end: false },
  { to: '/admin/templates', label: 'Templates', end: false },
  { to: '/admin/email', label: 'Email', end: false },
  { to: '/admin/support', label: 'Support', end: false },
] as const;

export default function AdminTabs() {
  const row = useRef<HTMLElement>(null);
  useRevealActive(row);
  return (
    <nav ref={row} aria-label="Admin" className="relative -mx-[13px] mb-4 flex gap-1.5 overflow-x-auto px-[13px] min-[721px]:mx-0 min-[721px]:px-0">
      {ADMIN_TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => cn(
            'flex min-h-[44px] shrink-0 items-center rounded-full border px-3.5 text-[13px] font-bold',
            isActive ? 'border-[#ffc9c4] bg-reason-pink text-reason-red-hover' : 'border-reason-line text-[#4d5562] hover:bg-reason-soft',
          )}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
