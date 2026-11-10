import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';
import SessionRetrying from './SessionRetrying';
import { type ReactNode } from 'react';
import { signInPathFor } from '@/features/auth/return-path';
import { gateTarget, isGateExempt, onboardingDue } from './onboarding-gate';
import { GUEST_HOME_PATH, guestAllowedPath, isEventGuest } from '@/features/call/guest-routes';

/**
 * The onboarding gate, always on (D2, then the 30 Oct review: L3). onboarding-gate.ts says who is due and for what:
 * the whole new onboarding for anyone who has not done it (admins too: deliberately no role exemption), or only
 * where they are based for someone who did it without. Its exempt pages are never diverted, and a session that does
 * not say fails open, never locking a client out over a field it does not know yet.
 *
 * An event guest (Part 2, Task 12) is placed before the gate and never reaches it: they are confined to their event, their
 * guest home, their bell and their settings (guest-routes.ts), and anything else sends them to the guest home. Platform
 * onboarding is for members; a guest becomes one through a join request, never by being sent into onboarding.
 */
export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isLoading, sessionRetrying } = useAuthStore();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="h-screen w-screen bg-white flex flex-col items-center justify-center gap-3 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
        {/* Its own height, not the screen's: the loader, the words and the buttons sit together in the middle. */}
        <div>
          <PageLoader />
        </div>
        {/* Fix wave 3: the session check is waiting out a 429, a 5xx or no connection. The member stays signed in. */}
        {sessionRetrying && <SessionRetrying />}
      </div>
    );
  }
  // 1 Nov 2026: straight to sign-in, carrying the page (a meeting link followed signed out lands back on it).
  // /welcome only redirects to /login, and that redirect dropped the page.
  if (!user) return <Navigate to={signInPathFor(location.pathname, location.search)} replace />;

  if (isEventGuest(user)) {
    return guestAllowedPath(location.pathname) ? <>{children}</> : <Navigate to={GUEST_HOME_PATH} replace />;
  }

  const due = onboardingDue(user);
  if (due && !isGateExempt(location.pathname)) {
    return <Navigate to={gateTarget(due, location.pathname, location.search)} replace />;
  }

  return <>{children}</>;
}
