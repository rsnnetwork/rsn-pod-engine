import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { Sparkles, ArrowRight, AlertCircle } from 'lucide-react';
import { API_BASE_URL } from '@/lib/runtimeEndpoints';

const API_URL = API_BASE_URL;

const ERROR_MESSAGES: Record<string, string> = {
  google_auth_failed: 'Google sign-in failed. Please try again.',
  INVITE_REQUIRED: 'An invite code is required for new accounts.',
  INVALID_INVITE: 'The invite code is invalid or expired.',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, setTokens, checkSession } = useAuthStore();
  const [params] = useSearchParams();
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const handlingCrossTabAuth = useRef(false);
  const { register, handleSubmit, formState: { errors, isSubmitting }, getValues, watch } = useForm<{ email: string; inviteCode: string }>();

  const inviteCodeValue = watch('inviteCode');

  // Store redirect path so VerifyPage can use it after login
  const redirectPath = params.get('redirect');
  if (redirectPath) {
    sessionStorage.setItem('rsn_redirect', redirectPath);
  }

  // Show error from OAuth redirect (e.g. ?error=INVITE_REQUIRED)
  const urlError = params.get('error');
  const displayError = authError || (urlError ? (ERROR_MESSAGES[urlError] || urlError) : null);

  useEffect(() => {
    const completeAuthInCurrentTab = async () => {
      if (!sent || handlingCrossTabAuth.current) return;

      const access = localStorage.getItem('rsn_access');
      const refresh = localStorage.getItem('rsn_refresh');
      if (!access || !refresh) return;

      handlingCrossTabAuth.current = true;
      try {
        setTokens(access, refresh);
        await checkSession();
        const redirect = sessionStorage.getItem('rsn_redirect');
        sessionStorage.removeItem('rsn_redirect');
        navigate(redirect || '/', { replace: true });
      } finally {
        handlingCrossTabAuth.current = false;
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'rsn_access' || event.key === 'rsn_auth_completed_at') {
        void completeAuthInCurrentTab();
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [sent, checkSession, navigate, setTokens]);

  const onSubmit = async (data: { email: string; inviteCode: string }) => {
    setAuthError(null);
    setDevLink(null);
    try {
      const response = await login(data.email, window.location.origin, data.inviteCode || undefined);
      setSent(true);
      // Capture devLink if returned (dev mode only)
      // Backend returns { success, data: { devLink, sent, message } }
      if (response?.data?.devLink) {
        setDevLink(response.data.devLink);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.response?.data?.data?.message || 'Failed to send magic link';
      setAuthError(msg);
    }
  };

  const handleGoogleLogin = () => {
    setAuthError(null);
    const googleUrl = new URL(`${API_URL}/auth/google`, window.location.origin);
    if (inviteCodeValue) {
      googleUrl.searchParams.set('inviteCode', inviteCodeValue);
    }
    window.location.href = googleUrl.toString();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950 p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-4">
            <Sparkles className="h-8 w-8 text-brand-400 animate-pulse-slow" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">RSN</h1>
          </div>
          <p className="text-surface-400 animate-fade-in" style={{ animationDelay: '0.2s' }}>Real-time peer networking for professionals</p>
        </div>

        <div className="rounded-2xl border border-surface-800 bg-surface-900/60 backdrop-blur-sm p-8 animate-fade-in-up" style={{ animationDelay: '0.15s' }}>
          {displayError && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-300">{displayError}</p>
            </div>
          )}

          {!sent ? (
            <>
              <h2 className="text-xl font-semibold text-surface-100 mb-6">Sign in to RSN</h2>

              {/* Google Login */}
              <button
                type="button"
                onClick={handleGoogleLogin}
                className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-xl border border-surface-700 bg-surface-800/50 text-surface-200 hover:bg-surface-800 hover:border-surface-600 transition-all text-sm font-medium"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Continue with Google
              </button>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-surface-700" /></div>
                <div className="relative flex justify-center text-xs"><span className="bg-surface-900 px-3 text-surface-500">or use email</span></div>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <Input
                  label="Email address"
                  type="email"
                  placeholder="you@example.com"
                  error={errors.email?.message}
                  {...register('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email' } })}
                />
                <Input
                  label="Invite code"
                  placeholder="Enter invite code (required for new users)"
                  error={errors.inviteCode?.message}
                  {...register('inviteCode')}
                />
                <p className="text-xs text-surface-500 -mt-2">Only required for first-time sign up</p>
                <Button type="submit" className="w-full group" isLoading={isSubmitting}>
                  Send magic link
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Button>
              </form>
              {redirectPath && (
                <p className="mt-4 text-xs text-surface-500 text-center">You'll be redirected after signing in</p>
              )}
            </>
          ) : (
            <div className="text-center space-y-4 animate-fade-in">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-brand-500/20 text-brand-400 mb-2">
                <Sparkles className="h-8 w-8" />
              </div>
              <h2 className="text-xl font-semibold text-surface-100">Check your email</h2>
              <p className="text-surface-400 text-sm">
                We sent a magic link to <span className="font-medium text-surface-200">{getValues('email')}</span>
              </p>
              <p className="text-surface-500 text-xs mt-1">Click the link in your email to sign in. It expires in 60 minutes.</p>
              <p className="text-surface-500 text-xs">This page will continue automatically after you verify the link.</p>

              {/* Dev mode: show direct link */}
              {devLink && (
                <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 mt-4 animate-fade-in">
                  <p className="text-xs text-amber-300 mb-2 font-semibold">DEV MODE — Direct Link</p>
                  <a
                    href={devLink}
                    className="inline-flex items-center gap-2 text-sm text-amber-400 hover:text-amber-300 underline"
                  >
                    Click here to verify
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              )}

              <button onClick={() => setSent(false)} className="text-sm text-surface-500 hover:text-surface-300 transition-colors">
                Try a different email
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
