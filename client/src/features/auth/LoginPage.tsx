import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { Sparkles, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  const { login } = useAuthStore();
  const [params] = useSearchParams();
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting }, getValues } = useForm<{ email: string }>();

  // Store redirect path so VerifyPage can use it after login
  const redirectPath = params.get('redirect');
  if (redirectPath) {
    sessionStorage.setItem('rsn_redirect', redirectPath);
  }

  const onSubmit = async (data: { email: string }) => {
    try {
      const res = await login(data.email);
      setSent(true);
      const link = res?.data?.devLink || res?.devLink;
      if (link) setDevLink(link);
    } catch {
      // error handled by store
    }
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
          {!sent ? (
            <>
              <h2 className="text-xl font-semibold text-surface-100 mb-6">Sign in with magic link</h2>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <Input
                  label="Email address"
                  type="email"
                  placeholder="you@example.com"
                  error={errors.email?.message}
                  {...register('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email' } })}
                />
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

              {devLink && (
                <div className="mt-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 animate-fade-in">
                  <p className="text-xs text-amber-400 font-semibold mb-2">DEV MODE — Click to verify:</p>
                  <a href={devLink} className="text-sm text-brand-400 underline break-all hover:text-brand-300 transition-colors">{devLink}</a>
                </div>
              )}

              <button onClick={() => { setSent(false); setDevLink(null); }} className="text-sm text-surface-500 hover:text-surface-300 transition-colors">
                Try a different email
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
