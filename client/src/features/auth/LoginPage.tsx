import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { ArrowRight, AlertCircle, KeyRound, Mail } from 'lucide-react';
import CheckEmailPanel from './CheckEmailPanel';
import { safeReturnPath } from './return-path';
import { rememberReturnPath, takeReturnPath } from './kept-return-path';
// Note: inviteCode is never entered manually — it arrives via URL param from /invite/:code flow
// and is passed silently to Google OAuth and magic link endpoints.
import { API_BASE_URL } from '@/lib/runtimeEndpoints';

const API_URL = API_BASE_URL;

// 1 Nov 2026 (30 Oct review: Stefan expected a password). Said where the sign-in starts.
const NO_PASSWORD = "No password needed — we'll email you a link and a code.";

const ERROR_MESSAGES: Record<string, string> = {
  google_auth_failed: 'Google sign-in failed. Please try again.',
  // The server refused a Google return that did not come back to the browser that started it.
  google_try_again: 'Google sign-in did not finish in this browser. Please try again.',
  INVALID_INVITE: 'The invite code is invalid or expired.',
  REGISTRATION_BLOCKED: 'You need an approved join request to sign up. Please request to join first.',
  ACCOUNT_CLOSED: 'This account was closed. Ask to join again, and you can sign in as soon as you are approved.',
  USER_SUSPENDED: 'This account is suspended. Please contact the REASON team if you think this is a mistake.',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, checkSession } = useAuthStore();
  // Set when the server ended a session because the account itself was refused.
  const signOutReason = useAuthStore((s) => s.signOutReason);
  const [params] = useSearchParams();
  const [sent, setSent] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [devLink, setDevLink] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const handlingCrossTabAuth = useRef(false);
  const inviteCodeFromUrl = params.get('inviteCode');
  const hasInvite = !!inviteCodeFromUrl;
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>();

  // Invite code comes silently from URL params (via /invite/:code flow) — no manual input needed
  const inviteCodeValue = inviteCodeFromUrl || '';

  // The page to come back to after sign-in (a signed-out visit to a protected page sends it here; 1 Nov 2026). This
  // tab keeps it for Google and the code; the emailed link carries it for another tab or device. Same-site paths only.
  const returnPath = safeReturnPath(params.get('redirect'));
  useEffect(() => {
    if (returnPath) rememberReturnPath(returnPath);
  }, [returnPath]);

  // Show error from OAuth redirect (e.g. ?error=INVITE_REQUIRED)
  const urlError = params.get('error');
  const displayError = authError
    || (urlError ? (ERROR_MESSAGES[urlError] || urlError) : null)
    || (signOutReason ? ERROR_MESSAGES[signOutReason] ?? null : null);

  useEffect(() => {
    const completeAuthInCurrentTab = async () => {
      if (!sent || handlingCrossTabAuth.current) return;

      // Adopt whatever tokens the verify tab wrote — do NOT re-write them (that
      // was the 7 Sep 2026 bug that clobbered the fresh refresh token).
      if (!useAuthStore.getState().adoptStoredTokens()) return;

      handlingCrossTabAuth.current = true;
      try {
        await checkSession();
        navigate(takeReturnPath() ?? '/', { replace: true });
      } finally {
        handlingCrossTabAuth.current = false;
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'rsn_tokens' || event.key === 'rsn_auth_completed_at') {
        void completeAuthInCurrentTab();
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [sent, checkSession, navigate]);

  const onSubmit = async (data: { email: string }) => {
    setAuthError(null);
    setDevLink(null);
    try {
      const response = await login(data.email, window.location.origin, inviteCodeValue || undefined, returnPath ?? undefined);
      setSentTo(data.email.trim());
      setSent(true);
      // Signal that this login tab is waiting for magic link verification
      localStorage.setItem('rsn_magic_link_sent', '1');
      // Capture devLink if returned (dev mode only)
      // Backend returns { success, data: { devLink, sent, message } }
      if (response?.data?.devLink) {
        setDevLink(response.data.devLink);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.response?.data?.data?.message || 'We could not send the email. Please try again.';
      setAuthError(msg);
    }
  };

  // A new email from the waiting screen: a new link and a new code (the older ones stop working). Errors go back to it.
  const resend = async () => {
    const response = await login(sentTo, window.location.origin, inviteCodeValue || undefined, returnPath ?? undefined);
    setDevLink(response?.data?.devLink ?? null);
  };

  // Signed in with the code, in this tab: on to the page the member was going to.
  const onCodeSignedIn = () => {
    localStorage.removeItem('rsn_magic_link_sent');
    navigate(takeReturnPath() ?? '/', { replace: true });
  };

  const [googleLoading, setGoogleLoading] = useState(false);

  // Back from Google, the browser may put this page back from its back-forward cache exactly as it was
  // left, the button still reading "Redirecting...". No code runs again then, but a pageshow event with
  // `persisted` set does, and it is the cue to let the member try again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setGoogleLoading(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const handleGoogleLogin = () => {
    if (googleLoading) return;
    setGoogleLoading(true);
    setAuthError(null);
    const googleUrl = new URL(`${API_URL}/auth/google`, window.location.origin);
    if (inviteCodeValue) {
      googleUrl.searchParams.set('inviteCode', inviteCodeValue);
    }
    // Where Google should bring the member back to: the site they are on (the app or the preview), the
    // same way the magic link names it. The server only honours its own sites, anything else lands on the app.
    googleUrl.searchParams.set('origin', window.location.origin);
    window.location.href = googleUrl.toString();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4 font-display">
      <div className="w-full max-w-md animate-fade-in-up">
        {/* REASON logo + header */}
        <div className="text-center mb-10">
          <img src="/reason-logo.png" alt="REASON" width={204} height={44} className="h-11 w-auto mx-auto mb-6" />
          <h1 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] tracking-tight">CONNECT WITH REASON</h1>
          {hasInvite && (
            <p className="mt-4 text-sm text-gray-500">You&apos;ve been invited — sign in to accept your invite</p>
          )}
        </div>

        {displayError && (
          <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-600">{displayError}</p>
          </div>
        )}

        {!sent ? (
          <div className="space-y-5">
            {/* Path 1: Existing User */}
            <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-6">
              <div className="flex items-center gap-2 mb-4">
                <KeyRound className="h-5 w-5 text-[#1a1a2e]" />
                <h2 className="text-base font-semibold text-[#1a1a2e]">Already a member? Sign in</h2>
              </div>
              <p className="text-sm text-gray-500 -mt-2 mb-4">{NO_PASSWORD}</p>

              {/* Google Login */}
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={googleLoading}
                className="w-full min-h-[44px] flex items-center justify-center gap-3 px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-gray-800 hover:bg-gray-100 hover:border-gray-300 transition-all text-sm font-medium mb-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {googleLoading ? (
                  <div className="h-5 w-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                ) : (
                  <svg className="h-5 w-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                )}
                {googleLoading ? 'Redirecting...' : 'Continue with Google'}
              </button>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-200" /></div>
                <div className="relative flex justify-center text-xs"><span className="bg-gray-50 px-3 text-gray-400">or use email</span></div>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
                <Input
                  label="Email address"
                  type="email"
                  placeholder="you@example.com"
                  className="min-h-[44px]"
                  error={errors.email?.message}
                  {...register('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email' } })}
                />
                <Button type="submit" className="w-full group" isLoading={isSubmitting}>
                  <Mail className="h-4 w-4 mr-2" />
                  Email me a link and a code
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Button>
              </form>
            </div>

            {/* Path 2: New User — Request to Join (hidden when arriving via invite) */}
            {!hasInvite && (
              <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-6 text-center">
                <h2 className="text-base font-semibold text-[#1a1a2e] mb-2">New here? Request access</h2>
                <p className="text-sm text-gray-500 mb-4">REASON is invite-only. Apply and we&apos;ll review your request.</p>
                <button
                  onClick={() => navigate('/request-to-join')}
                  className="bg-rsn-red text-white px-6 py-2.5 min-h-[44px] rounded-full text-sm font-semibold hover:bg-rsn-red-hover transition-all hover:scale-[1.02] shadow-md inline-flex items-center gap-2"
                >
                  Request to Join <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}

            {returnPath && (
              <p className="text-xs text-gray-400 text-center">You&apos;ll be redirected after signing in</p>
            )}
          </div>
        ) : (
          <CheckEmailPanel
            email={sentTo}
            devLink={devLink}
            onResend={resend}
            onDifferentEmail={() => setSent(false)}
            onSignedIn={onCodeSignedIn}
          />
        )}

      </div>
    </div>
  );
}
