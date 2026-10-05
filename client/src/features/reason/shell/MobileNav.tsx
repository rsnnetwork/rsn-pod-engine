import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { cn, isAdmin } from '@/lib/utils';
import Sheet from '../ui/Sheet';
import { ReasonIcon } from '../ui/icons';
import { MOBILE_MORE, MOBILE_PRIMARY, NAV_BY_KEY, isAccountPage, onAdmin, onInvites } from './nav';
import LogoutSheet from './LogoutSheet';

const TAB = 'relative grid min-h-[56px] min-w-0 content-center justify-items-center gap-0.5 rounded-xl px-1 text-[10px] font-bold';
const ACCOUNT_LINK = 'flex min-h-[44px] items-center rounded-xl px-1 text-[14px]';
const ACCOUNT_LINK_HERE = 'bg-reason-pink font-bold text-reason-red';

export default function MobileNav({ unreadCount }: { unreadCount: number }) {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const moreActive = MOBILE_MORE.some((k) => NAV_BY_KEY[k].match(pathname)) || pathname === '/profile' || isAccountPage(pathname);
  const done = () => setMoreOpen(false);

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 gap-0.5 border-t border-reason-line bg-white/95 pt-1.5 backdrop-blur-lg pb-[calc(6px+env(safe-area-inset-bottom))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] min-[721px]:hidden"
      >
        {MOBILE_PRIMARY.map((key) => {
          const item = NAV_BY_KEY[key];
          const active = item.match(pathname);
          return (
            <Link
              key={key}
              to={item.to}
              aria-label={key === 'messages' && unreadCount > 0 ? `${item.label}, ${unreadCount} unread` : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(TAB, active ? 'bg-reason-pink text-reason-red' : 'text-[#697180]')}
            >
              <ReasonIcon name={key} />
              <span>{item.label}</span>
              {key === 'messages' && unreadCount > 0 && (
                <i className="absolute right-[18%] top-1 grid h-4 min-w-4 place-items-center rounded-full bg-reason-red px-1 text-[9px] not-italic text-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </i>
              )}
            </Link>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen} aria-current={moreActive ? 'true' : undefined} className={cn(TAB, moreActive ? 'bg-reason-pink text-reason-red' : 'text-[#697180]')}>
          <ReasonIcon name="more" />
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onClose={done} title="More">
        <div className="grid grid-cols-2 gap-2 pb-2">
          {MOBILE_MORE.map((key) => {
            const item = NAV_BY_KEY[key];
            const active = item.match(pathname);
            return (
              <Link
                key={key}
                to={item.to}
                onClick={done}
                aria-current={active ? 'page' : undefined}
                className={cn('flex min-h-[48px] items-center gap-2.5 rounded-[13px] border px-3 text-[14px] font-bold', active ? 'border-[#ffc9c4] bg-reason-pink text-reason-red' : 'border-reason-line text-[#323946]')}
              >
                <ReasonIcon name={key} width={20} height={20} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
        {user && (
          <div className="mt-2 grid gap-1 border-t border-reason-line pb-1 pt-3">
            <Link to="/profile" onClick={done} aria-current={pathname === '/profile' ? 'page' : undefined} className="flex min-h-[48px] items-center gap-2.5 rounded-xl px-1">
              <Avatar src={user.avatarUrl} name={user.displayName || 'You'} size="sm" />
              <span>
                <strong className="block text-[13px]">{user.displayName || 'You'}</strong>
                <small className="text-reason-muted">View profile</small>
              </span>
            </Link>
            <Link to="/invites" onClick={done} aria-current={onInvites(pathname) ? 'page' : undefined} className={cn(ACCOUNT_LINK, onInvites(pathname) && ACCOUNT_LINK_HERE)}>Invite someone</Link>
            {isAdmin(user.role) && <Link to="/admin" onClick={done} aria-current={onAdmin(pathname) ? 'page' : undefined} className={cn(ACCOUNT_LINK, onAdmin(pathname) && ACCOUNT_LINK_HERE)}>Admin</Link>}
            <button type="button" onClick={() => { done(); setConfirm(true); }} className="flex min-h-[44px] items-center rounded-xl px-1 text-left text-[14px] text-reason-red">Log out</button>
          </div>
        )}
      </Sheet>
      <LogoutSheet open={confirm} onClose={() => setConfirm(false)} />
    </>
  );
}
