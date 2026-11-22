// The signed-in frame an event guest sees (Part 2, Task 12): the REASON mark (to their events), their bell, Settings and
// Log out. No member navigation at all: For You, People, Entities, Circles, Pods, Events and Messages are for members,
// and the guest home offers membership instead. Used by ReasonShell in place of the member shell for a guest, so the
// guest-allowed pages (/my-events, /notifications, /settings) keep their one route each.
import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { LogOut, Settings } from 'lucide-react';
import NotificationBell from '@/components/ui/NotificationBell';
import ToastContainer from '@/components/ui/Toast';
import ReasonMark from '@/features/reason/brand/ReasonMark';
import LogoutSheet from '@/features/reason/shell/LogoutSheet';
import { GUEST_HOME_PATH } from './guest-routes';

const ICON_BUTTON = 'grid h-11 w-11 place-items-center rounded-xl border border-reason-line bg-white text-reason-ink hover:bg-reason-soft';

export default function GuestShell() {
  const [confirmLogout, setConfirmLogout] = useState(false);
  return (
    <div className="min-h-[100dvh] bg-reason-warm font-reason text-reason-ink antialiased" data-testid="guest-shell">
      <header
        className="sticky top-0 z-[12] border-b border-reason-line bg-white/95 backdrop-blur-lg"
        style={{
          paddingTop: 'max(8px, env(safe-area-inset-top))',
          paddingLeft: 'max(12px, env(safe-area-inset-left))',
          paddingRight: 'max(12px, env(safe-area-inset-right))',
        }}
      >
        <div className="mx-auto flex h-[60px] w-full max-w-[960px] items-center justify-between gap-2">
          <Link to={GUEST_HOME_PATH} aria-label="Your events" className="flex min-h-[44px] min-w-0 items-center">
            <ReasonMark variant="mobile" />
          </Link>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <Link to="/settings" aria-label="Settings" className={ICON_BUTTON}>
              <Settings aria-hidden="true" className="h-5 w-5" />
            </Link>
            <button type="button" onClick={() => setConfirmLogout(true)} aria-label="Log out" className={ICON_BUTTON}>
              <LogOut aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>
      <main
        className="mx-auto w-full max-w-[960px] pt-5 sm:pt-8"
        style={{
          paddingBottom: 'max(32px, env(safe-area-inset-bottom))',
          paddingLeft: 'max(16px, env(safe-area-inset-left))',
          paddingRight: 'max(16px, env(safe-area-inset-right))',
        }}
      >
        <Outlet />
      </main>
      <LogoutSheet open={confirmLogout} onClose={() => setConfirmLogout(false)} />
      <ToastContainer />
    </div>
  );
}
