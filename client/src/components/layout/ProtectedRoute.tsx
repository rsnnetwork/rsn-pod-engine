import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';
import { type ReactNode } from 'react';

export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isLoading } = useAuthStore();
  const location = useLocation();

  if (isLoading) return <div className="h-screen w-screen bg-white flex items-center justify-center"><PageLoader /></div>;
  if (!user) return <Navigate to="/welcome" state={{ from: location }} replace />;

  // Gate onboarding to first login for NEW users only. Existing users who completed
  // the prior onboarding flow are grandfathered — we don't re-route them even if their
  // profile fields don't match the new mandatory-field set. New-user signups MUST fill
  // the required fields because /auth/onboarding/complete rejects incomplete bodies.
  const isOnboarding = location.pathname === '/onboarding';
  const isLiveSession = location.pathname.startsWith('/sessions/') && location.pathname.includes('/live');
  const onboardingCompleted = (user as any).onboardingCompleted === true;
  if (!onboardingCompleted && !isOnboarding && !isLiveSession) {
    const safeRedirect = location.pathname.startsWith('/onboarding') ? '/' : location.pathname;
    return <Navigate to={`/onboarding?redirect=${encodeURIComponent(safeRedirect)}`} replace />;
  }

  return <>{children}</>;
}
