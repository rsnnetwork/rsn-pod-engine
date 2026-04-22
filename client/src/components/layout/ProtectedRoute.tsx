import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';
import { type ReactNode } from 'react';

/**
 * T1-2 (Issue 1) — auth-only gate. The onboarding redirect that used to
 * live here was over-broad: it forced returning users with stale
 * `onboarding_completed=false` flags to re-fill their profile, AND it
 * intercepted /invite/:code → onboarding redirects that broke the
 * "click invite, land in event" UX.
 *
 * Now ProtectedRoute checks ONLY auth. Onboarding is invited via:
 *   1. New magic-link signups land on /auth/verify → /onboarding directly
 *      (legacy path, unchanged for that specific flow)
 *   2. Returning users with incomplete profiles see a non-blocking banner
 *      in AppLayout — they can use the app, complete profile when ready
 *   3. Invited users (created with onboarding_completed=true server-side)
 *      go straight into the event/lobby
 *
 * Rollback flag: VITE_LEGACY_ONBOARDING_GATE=true restores the pre-T1-2
 * blocking gate. Default off (new behaviour).
 */
export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isLoading } = useAuthStore();
  const location = useLocation();

  if (isLoading) return <div className="h-screen w-screen bg-white flex items-center justify-center"><PageLoader /></div>;
  if (!user) return <Navigate to="/welcome" state={{ from: location }} replace />;

  // Legacy gate (env-flagged for emergency rollback only)
  if (import.meta.env.VITE_LEGACY_ONBOARDING_GATE === 'true') {
    const isOnboarding = location.pathname === '/onboarding';
    const isLiveSession = location.pathname.startsWith('/sessions/') && location.pathname.includes('/live');
    const isInviteLanding = location.pathname.startsWith('/invite/');
    const onboardingCompleted = (user as any).onboardingCompleted === true;
    // Even in legacy mode, exempt /invite/:code so the invite-acceptance
    // flow can complete (this was the documented bug from the 22nd April
    // review — old gate intercepted invite landings too).
    if (!onboardingCompleted && !isOnboarding && !isLiveSession && !isInviteLanding) {
      const safeRedirect = location.pathname.startsWith('/onboarding') ? '/' : location.pathname;
      return <Navigate to={`/onboarding?redirect=${encodeURIComponent(safeRedirect)}`} replace />;
    }
  }

  return <>{children}</>;
}
