import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';

interface VerifyFailure {
  message: string;
  nextLabel: string;
  nextHref: string;
}

const FRESH_LINK = { nextLabel: 'Get a fresh link', nextHref: '/login' };

/** Map the server's error code to a human message + the next step that actually helps. */
function failureForVerifyError(err: any): VerifyFailure {
  const code = err?.response?.data?.error?.code;
  switch (code) {
    case 'AUTH_MAGIC_LINK_USED':
      return { message: 'This sign-in link has already been used. Get a fresh link below.', ...FRESH_LINK };
    case 'AUTH_MAGIC_LINK_EXPIRED':
      return { message: 'This sign-in link has expired. Get a fresh link below.', ...FRESH_LINK };
    case 'RATE_LIMIT_EXCEEDED':
      return { message: 'Too many sign-in attempts. Please wait a few minutes, then get a fresh link.', ...FRESH_LINK };
    // A fresh link cannot help these two: the account itself is refused.
    case 'ACCOUNT_CLOSED':
      return {
        message: 'This account was closed. Ask to join again, and you can sign in as soon as you are approved.',
        nextLabel: 'Ask to join again',
        nextHref: '/request-to-join',
      };
    case 'USER_SUSPENDED':
      return {
        message: 'This account is suspended. Please contact the RSN team if you think this is a mistake.',
        nextLabel: 'Back to sign in',
        nextHref: '/login',
      };
    default:
      return { message: 'We could not sign you in. Get a fresh link below and try again.', ...FRESH_LINK };
  }
}

export default function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { verify, setTokensAndLoad } = useAuthStore();
  const [error, setError] = useState<VerifyFailure | null>(null);
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
        .catch(() => setError({ message: 'Google sign-in did not finish. Please try again.', ...FRESH_LINK }));
    } else if (token) {
      // Magic link flow — surface WHY it failed so the user knows to get a
      // fresh link rather than staring at a generic "invalid" message.
      verify(token)
        .then(redirectAfterAuth)
        .catch((err) => setError(failureForVerifyError(err)));
    } else {
      setError({ message: 'This sign-in link is incomplete. Get a fresh link below.', ...FRESH_LINK });
    }
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white p-4">
        <div className="text-center space-y-4 animate-fade-in">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-red-500/20 text-red-400 mx-auto mb-2">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <p className="text-red-400 text-lg max-w-md mx-auto">{error.message}</p>
          <a href={error.nextHref} className="inline-flex min-h-[44px] items-center text-rsn-red underline hover:text-rsn-red-hover transition-colors">{error.nextLabel}</a>
        </div>
      </div>
    );
  }

  return <PageLoader />;
}
