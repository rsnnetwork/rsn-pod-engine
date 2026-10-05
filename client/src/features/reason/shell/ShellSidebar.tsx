import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import ReasonMark from '../brand/ReasonMark';
import { ReasonIcon } from '../ui/icons';
import { MAIN_NAV, SUB_NAV, type NavItem } from './nav';
import ProfileMenu from './ProfileMenu';

function SideLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  return (
    <Link
      to={item.to}
      aria-label={badge ? `${item.label}, ${badge} unread` : item.label}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      className={cn(
        'relative flex min-h-[44px] items-center justify-center gap-3 rounded-xl px-2.5 text-[15px] transition-colors min-[981px]:justify-start',
        active ? 'bg-reason-pink font-bold text-reason-red shadow-[inset_3px_0_0_#DE322E]' : 'text-[#515968] hover:bg-reason-soft hover:text-[#111]',
      )}
    >
      <ReasonIcon name={item.key} className="shrink-0" />
      <span className="hidden min-[981px]:inline">{item.label}</span>
      {!!badge && (
        <i className="absolute right-1 top-1 grid h-[21px] min-w-[21px] place-items-center rounded-full bg-reason-red px-1.5 text-[11px] font-extrabold not-italic text-white min-[981px]:static min-[981px]:ml-auto">
          {badge > 9 ? '9+' : badge}
        </i>
      )}
    </Link>
  );
}

export default function ShellSidebar({ unreadCount }: { unreadCount: number }) {
  const { pathname } = useLocation();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[calc(82px+env(safe-area-inset-left))] flex-col border-r border-reason-line bg-white pb-[calc(14px+env(safe-area-inset-bottom))] pl-[calc(14px+env(safe-area-inset-left))] pr-3.5 pt-4 min-[721px]:flex min-[981px]:w-[calc(232px+env(safe-area-inset-left))]">
      <div className="flex h-[52px] shrink-0 items-center justify-center pb-2 min-[981px]:justify-start">
        <Link to="/" aria-label="REASON home" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl px-2">
          <ReasonMark variant="rail" />
        </Link>
      </div>
      {/* On a short window (a phone on its side) this part scrolls, so the account
          block below it is never pushed off the bottom of the screen. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
        <nav className="mt-2.5 grid shrink-0 gap-1 pb-3" aria-label="Main">
          {MAIN_NAV.map((item) => (
            <SideLink key={item.key} item={item} active={item.match(pathname)} badge={item.key === 'messages' ? unreadCount : undefined} />
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
