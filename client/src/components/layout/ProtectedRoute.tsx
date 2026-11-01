import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';
import { type ReactNode } from 'react';
import { signInPathFor } from '@/features/auth/return-path';
import { gateTarget, isGateExempt, onboardingDue } from './onboarding-gate';

/**
 * The onboarding gate, always on (D2, then the 30 Oct review: L3). onboarding-gate.ts says who is due and for what:
 * the whole new onboarding for anyone who has not done it (admins too: deliberately no role exemption), or only
 * where they are based for someone who did it without. Its exempt pages are never diverted, and a session that does
 * not say fails open, never locking a client out over a field it does not know yet.
 */
export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isLoading } = useAuthStore();
  const location = useLocation();

  if (isLoading) return <div className="h-screen w-screen bg-white flex items-center justify-center"><PageLoader /></div>;
  // 1 Nov 2026: straight to sign-in, carrying the page (a meeting link followed signed out lands back on it).
  // /welcome only redirects to /login, and that redirect dropped the page.
  if (!user) return <Navigate to={signInPathFor(location.pathname, location.search)} replace />;

  const due = onboardingDue(user);
  if (due && !isGateExempt(location.pathname)) {
    return <Navigate to={gateTarget(due, location.pathname, location.search)} replace />;
  }

  return <>{children}</>;
}
