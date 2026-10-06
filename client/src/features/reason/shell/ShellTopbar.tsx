import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import NotificationBell from '@/components/ui/NotificationBell';
import { useAuthStore } from '@/stores/authStore';
import ReasonMark from '../brand/ReasonMark';

export default function ShellTopbar() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };
  return (
    <header className="z-[12] grid shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[44px_44px] items-center gap-x-2.5 gap-y-[7px] border-b border-reason-line bg-white/95 pb-2.5 pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] pt-[max(9px,env(safe-area-inset-top))] backdrop-blur-lg min-[721px]:flex min-[721px]:h-[66px] min-[721px]:gap-[18px] min-[721px]:pl-[22px] min-[721px]:pr-[max(22px,env(safe-area-inset-right))] min-[721px]:py-0">
      <Link to="/" aria-label="REASON home" className="flex min-h-[44px] items-center min-[721px]:hidden">
        <ReasonMark variant="mobile" />
      </Link>
      <form onSubmit={submit} role="search" className="relative col-span-2 row-start-2 w-full min-w-0 min-[721px]:w-[min(520px,52vw)]">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#303641]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search REASON"
          placeholder="Search people, entities, circles, pods or events…"
          className="h-11 w-full text-ellipsis rounded-xl border border-transparent bg-[#f4f5f7] pl-10 pr-3 text-[16px] outline-none transition placeholder:text-[#646a77] focus:border-[#cfd2d8] focus:bg-white focus:shadow-[0_0_0_4px_rgba(222,50,46,.06)] min-[721px]:text-[15px]"
        />
      </form>
      <div className="col-start-2 row-start-1 flex items-center gap-2 min-[721px]:ml-auto">
        <NotificationBell />
        <Link to="/profile" aria-label="Your profile" className="grid h-11 w-11 place-items-center rounded-xl border border-reason-line bg-white">
          <Avatar src={user?.avatarUrl} name={user?.displayName || 'You'} size="sm" />
        </Link>
      </div>
    </header>
  );
}
