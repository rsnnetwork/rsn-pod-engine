// Replaces AppLayout for every signed-in page on the preview. Socket life,
// entity invalidation and the incoming-call banner live in App.tsx, so they
// keep working here unchanged.
//
// <main> is the scroll area, exactly as it was in AppLayout, and not the
// window. Old pages were built for that: Messages sizes itself to what <main>
// gives it, the Admin bulk bars stick to the top of <main> (a sticky top bar
// outside it would hide them), and a page that is wider than the screen scrolls
// inside <main> instead of dragging the whole window sideways.
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { isAdmin } from '@/lib/utils';
import ToastContainer from '@/components/ui/Toast';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
import ShellSidebar from './ShellSidebar';
import ShellTopbar from './ShellTopbar';
import MobileNav from './MobileNav';
import PeopleTabs, { PEOPLE_TABS } from './PeopleTabs';
import AdminTabs from './AdminTabs';

export default function ReasonShell() {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const userId = user?.id as string | undefined;
  const { data: unread } = useQuery({
    queryKey: ['dm-unread-count'],
    queryFn: () => api.get('/dm/unread-count').then((r) => r.data.data.count as number),
    enabled: !!userId,
    meta: { entities: userId ? [E.userDms(userId)] : [] },
  });
  const unreadCount = unread ?? 0;
  const inPeople = PEOPLE_TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  const inAdmin = isAdmin(user?.role) && (pathname === '/admin' || pathname.startsWith('/admin/'));
  // The old layout's nudge, kept. For You says the same thing in its own card.
  const nudgeProfile = user?.onboardingCompleted === false && pathname !== '/';

  return (
    <div className="h-[100dvh] overflow-hidden bg-white font-reason text-reason-ink antialiased">
      <ShellSidebar unreadCount={unreadCount} />
      <div className="flex h-full min-w-0 flex-col min-[721px]:pl-[calc(82px+env(safe-area-inset-left))] min-[981px]:pl-[calc(232px+env(safe-area-inset-left))]">
        <ShellTopbar />
        <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(96px+env(safe-area-inset-bottom))] pl-[max(13px,env(safe-area-inset-left))] pr-[max(13px,env(safe-area-inset-right))] pt-4 min-[721px]:pb-10 min-[721px]:pl-[22px] min-[721px]:pr-[max(22px,env(safe-area-inset-right))] min-[721px]:pt-[22px]">
          <div className="mx-auto w-full max-w-[1400px]">
            {nudgeProfile && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#f3dcb8] bg-[#fff8ec] px-4 py-3 text-[13px]">
                <span><strong>Complete your profile</strong> so REASON can suggest people with a reason to meet you.</span>
                <Link to="/onboarding" className="flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 font-bold text-white">Complete now</Link>
              </div>
            )}
            {inPeople && <PeopleTabs />}
            {inAdmin && <AdminTabs />}
            <Outlet />
          </div>
        </main>
      </div>
      <MobileNav unreadCount={unreadCount} />
      <OnboardingTour />
      <ToastContainer />
    </div>
  );
}
