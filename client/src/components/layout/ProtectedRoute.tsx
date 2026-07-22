import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';
import { type ReactNode } from 'react';

/**
 * D2 — always-on re-onboarding gate, keyed on `user.onboardingStatus`
 * (D1: GET /auth/session now returns this; see shared/src/types/user.ts).
 * Supersedes T1-2's flag-gated legacy block (env-flagged, off by default),
 * which is deleted entirely — no rollback flag, this gate is always on.
 *
 *   - Any status other than 'completed' gates the user to /onboarding,
 *     except the exempt paths below (deliberately no role exemption —
 *     admins go through onboarding too, they're the first test cohort).
 *   - `undefined` (a stale cached session payload mid-deploy, from before
 *     D1 shipped) fails OPEN — never lock a client out over a field it
 *     doesn't know about yet.
 *   - Exempt: /onboarding itself (no redirect loop), /invite/:code (accept
 *     flow must complete), and live-event session paths (/session/:id/live).
 */
export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isLoading } = useAuthStore();
  const location = useLocation();

  if (isLoading) return <div className="h-screen w-screen bg-white flex items-center justify-center"><PageLoader /></div>;
  if (!user) return <Navigate to="/welcome" state={{ from: location }} replace />;

  const status = user.onboardingStatus;
  const needsOnboarding = status !== undefined && status !== 'completed';
  const exempt =
    location.pathname === '/onboarding' ||
    location.pathname.startsWith('/invite/') ||
    (location.pathname.startsWith('/session/') && location.pathname.includes('/live'));
  if (needsOnboarding && !exempt) {
    const safeRedirect = location.pathname.startsWith('/onboarding') ? '/' : location.pathname;
    return <Navigate to={`/onboarding?redirect=${encodeURIComponent(safeRedirect)}`} replace />;
  }

  return <>{children}</>;
}
