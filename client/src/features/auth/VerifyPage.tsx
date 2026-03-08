import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { PageLoader } from '@/components/ui/Spinner';

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

      // Try to close this tab (works when opened via link from email)
      // If the browser blocks window.close(), fall back to redirect
      const redirect = sessionStorage.getItem('rsn_redirect');
      sessionStorage.removeItem('rsn_redirect');

      // Small delay to let localStorage event propagate to the original tab
      setTimeout(() => {
        window.close();
        // If window.close() was blocked (some browsers), redirect normally
        navigate(redirect || '/', { replace: true });
      }, 500);
    };

    if (accessToken && refreshToken) {
      // Google OAuth flow — tokens provided directly
      setTokensAndLoad(accessToken, refreshToken)
        .then(redirectAfterAuth)
        .catch(() => setError('Failed to authenticate with Google. Please try again.'));
    } else if (token) {
      // Magic link flow
      verify(token)
        .then(redirectAfterAuth)
        .catch(() => setError('Invalid or expired link. Please try again.'));
    } else {
      setError('Missing authentication token');
    }
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-950 p-4">
        <div className="text-center space-y-4 animate-fade-in">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-red-500/20 text-red-400 mx-auto mb-2">
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <p className="text-red-400 text-lg">{error}</p>
          <a href="/login" className="text-brand-400 underline hover:text-brand-300 transition-colors">Back to login</a>
        </div>
      </div>
    );
  }

  return <PageLoader />;
}
