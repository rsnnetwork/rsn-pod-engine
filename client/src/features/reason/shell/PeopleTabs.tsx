// Until People is rebuilt (next milestone), the four existing people pages sit
// under one row of tabs, so none of them is lost from the new navigation.
import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import useRevealActive from './useRevealActive';

export const PEOPLE_TABS = [
  { to: '/search', label: 'Find people' },
  { to: '/agents', label: 'Your searches' },
  { to: '/matches', label: 'Everyone who fits' },
  { to: '/encounters', label: 'People you have met' },
] as const;

export default function PeopleTabs() {
  const row = useRef<HTMLElement>(null);
  useRevealActive(row);
  return (
    <nav ref={row} aria-label="People" className="relative -mx-[13px] mb-4 flex gap-1.5 overflow-x-auto px-[13px] min-[721px]:mx-0 min-[721px]:px-0">
      {PEOPLE_TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) => cn(
            'flex min-h-[44px] shrink-0 items-center rounded-full border px-3.5 text-[13px] font-bold',
            isActive ? 'border-[#ffc9c4] bg-reason-pink text-reason-red' : 'border-reason-line text-[#4d5562] hover:bg-reason-soft',
          )}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
