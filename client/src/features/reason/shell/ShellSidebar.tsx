import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useEventsBadge } from '@/features/meetings/useMeetings';
import { eventsLinkName } from '@/features/meetings/meeting-words';
import ReasonMark from '../brand/ReasonMark';
import { ReasonIcon } from '../ui/icons';
import { MAIN_NAV, SUB_NAV, type NavItem } from './nav';
import ProfileMenu from './ProfileMenu';

/** What a link carries beside its label: a count, the link's name with that count in it, and (Events) the live dot. */
interface LinkBadge { count: number; name: string; liveNow?: boolean }

function SideLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: LinkBadge }) {
  const count = badge?.count ?? 0;
  return (
    <Link
      to={item.to}
      aria-label={badge?.name ?? item.label}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      className={cn(
        'relative flex min-h-[44px] items-center justify-center gap-3 rounded-xl px-2.5 text-[15px] transition-colors min-[981px]:justify-start',
        active ? 'bg-reason-pink font-bold text-reason-red-hover shadow-[inset_3px_0_0_#DE322E]' : 'text-[#515968] hover:bg-reason-soft hover:text-[#111]',
      )}
    >
      <span className="relative flex shrink-0">
        {/* The label is the darker red (4.5:1 on the pink); the icon is not text and keeps the brand red. */}
        <ReasonIcon name={item.key} className={cn('shrink-0', active && 'text-reason-red')} />
        {/* A meeting can be joined now. The link's name says so in words. */}
        {badge?.liveNow && <span data-live-now aria-hidden="true" className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-reason-green ring-2 ring-white motion-safe:animate-pulse" />}
      </span>
      <span className="hidden min-[981px]:inline">{item.label}</span>
      {count > 0 && (
        <i className="absolute right-1 top-1 grid h-[21px] min-w-[21px] place-items-center rounded-full bg-reason-red px-1.5 text-[11px] font-extrabold not-italic text-white min-[981px]:static min-[981px]:ml-auto">
          {count > 9 ? '9+' : count}
        </i>
      )}
    </Link>
  );
}

export default function ShellSidebar({ unreadCount }: { unreadCount: number }) {
  const { pathname } = useLocation();
  // The Events count: upcoming meetings, and a live dot while one can be joined (26 Oct 2026, CON-05).
  const meetings = useEventsBadge();
  const badgeFor = (item: NavItem): LinkBadge | undefined => {
    if (item.key === 'messages') return { count: unreadCount, name: unreadCount ? `${item.label}, ${unreadCount} unread` : item.label };
    if (item.key === 'events') return { count: meetings.count, name: eventsLinkName(item.label, meetings.count, meetings.liveNow), liveNow: meetings.liveNow };
    return undefined;
  };
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[calc(82px+env(safe-area-inset-left))] flex-col border-r border-reason-line bg-white pb-[calc(14px+env(safe-area-inset-bottom))] pl-[calc(14px+env(safe-area-inset-left))] pr-3.5 pt-4 min-[721px]:flex min-[981px]:w-[calc(232px+env(safe-area-inset-left))]">
      <div className="flex h-[52px] shrink-0 items-center justify-center pb-2 min-[981px]:justify-start">
        {/* The rail's 53px of room holds the 40px sheep only with 4px of padding a side: with 8px the link shrinks and
            the picture is squeezed to 37px. The sidebar has room for the wider padding. */}
        <Link to="/" aria-label="REASON home" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl px-1 min-[981px]:px-2">
          <ReasonMark variant="rail" />
        </Link>
      </div>
      {/* On a short window (a phone on its side) this part scrolls, so the account
          block below it is never pushed off the bottom of the screen. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
        <nav className="mt-2.5 grid shrink-0 gap-1 pb-3" aria-label="Main">
          {MAIN_NAV.map((item) => (
            <SideLink key={item.key} item={item} active={item.match(pathname)} badge={badgeFor(item)} />
          ))}
        </nav>
        <div className="mt-auto grid shrink-0 gap-1 border-t border-reason-line pt-3">
          {SUB_NAV.map((item) => <SideLink key={item.key} item={item} active={item.match(pathname)} />)}
        </div>
      </div>
      <ProfileMenu />
    </aside>
  );
}
