import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';

/** Map the server's error code to a human message + whether a new link helps. */
function messageForVerifyError(err: any): string {
  const code = err?.response?.data?.error?.code;
  switch (code) {
    case 'AUTH_MAGIC_LINK_USED':
      return 'This sign-in link has already been used. Get a fresh link below.';
    case 'AUTH_MAGIC_LINK_EXPIRED':
      return 'This sign-in link has expired. Get a fresh link below.';
    case 'RATE_LIMIT_EXCEEDED':
      return 'Too many sign-in attempts. Please wait a few minutes, then get a fresh link.';
    default:
      return 'We could not sign you in. Get a fresh link below and try again.';
  }
}

export default function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { verify, setTokensAndLoad } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    const token = params.get('token');
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');

    const redirectAfterAuth = () => {
      // Signal original login tab that auth is complete
      localStorage.setItem('rsn_auth_completed_at', String(Date.now()));

      // Priority: inviteCode from URL (Google OAuth) > sessionStorage (magic link) > home
      const inviteCode = params.get('inviteCode');
      const redirect = sessionStorage.getItem('rsn_redirect');
      sessionStorage.removeItem('rsn_redirect');
      // Land on the destination (or the dashboard). New / not-yet-onboarded users
      // are INVITED into the host chat by a welcome popup on the dashboard, never
      // auto-redirected here.
      const destination = inviteCode ? `/invite/${inviteCode}` : (redirect || '/');

      // Clear magic link flag so original tab knows auth is done
      localStorage.removeItem('rsn_magic_link_sent');

      // Always navigate in this tab — never close it.
      // Both tabs stay open and usable: original tab picks up auth via localStorage event,
      // this tab navigates to the destination.
      navigate(destination, { replace: true });
    };

    if (accessToken && refreshToken) {
      // Google OAuth flow — tokens provided directly
      setTokensAndLoad(accessToken, refreshToken)
        .then(redirectAfterAuth)
        .catch(() => setError('Failed to authenticate with Google. Please try again.'));
    } else if (token) {
      // Magic link flow — surface WHY it failed so the user knows to get a
      // fresh link rather than staring at a generic "invalid" message.
      verify(token)
        .then(redirectAfterAuth)
        .catch((err) => setError(messageForVerifyError(err)));
    } else {
      setError('Missing authentication token');
    }
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white p-4">
        <div className="text-center space-y-4 animate-fade-in">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-red-500/20 text-red-400 mx-auto mb-2">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <p className="text-red-400 text-lg">{error}</p>
          <a href="/login" className="text-rsn-red underline hover:text-rsn-red-hover transition-colors">Get a fresh link</a>
        </div>
      </div>
    );
  }

  return <PageLoader />;
}
