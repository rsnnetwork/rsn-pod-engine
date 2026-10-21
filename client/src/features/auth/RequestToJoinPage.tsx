import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { ArrowRight, CheckCircle, ArrowLeft } from 'lucide-react';
import api from '@/lib/api';
import { errorMessage } from '@/features/reason/errors';
import { normalizeLinkedinInput, LINKEDIN_LINK_HELP } from './linkedin-link';

interface RequestForm {
  fullName: string;
  email: string;
  linkedinUrl: string;
  reason: string;
}

const SEND_FAILED = 'We could not send your request. Please try again.';
const REASON_REQUIRED = 'Please tell us why you want to join';

export default function RequestToJoinPage() {
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RequestForm>();

  const onSubmit = async (data: RequestForm) => {
    setSubmitError(null);
    // LinkedIn is optional: an empty box sends no address at all, and a filled one always goes as
    // https://www.linkedin.com/in/<name>, however it was typed.
    const linkedinUrl = normalizeLinkedinInput(data.linkedinUrl);
    try {
      await api.post('/join-requests', {
        fullName: data.fullName,
        email: data.email,
        reason: data.reason,
        ...(linkedinUrl ? { linkedinUrl } : {}),
      });
      setSubmitted(true);
    } catch (err) {
      setSubmitError(errorMessage(err, SEND_FAILED));
    }
  };

  return (
    <div
      className="min-h-[100dvh] flex items-center justify-center bg-white px-4 py-6 font-display"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <div className="w-full max-w-lg animate-fade-in-up">
        {/* REASON logo + header */}
        <div className="text-center mb-8 sm:mb-10">
          <img
            src="/reason-logo.png"
            alt="REASON"
            width={204}
            height={44}
            className="h-11 w-auto mx-auto mb-6 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => navigate('/welcome')}
          />
          <h1 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] tracking-tight">REQUEST TO JOIN</h1>
          <p className="text-gray-500 text-sm mt-2 tracking-wide">REASON is invite-only.</p>
        </div>

        {!submitted ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-5 sm:p-8">
            {submitError && (
              <div role="alert" className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200">
                <p className="text-sm text-red-600">{submitError}</p>
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <Input
                label="Full Name"
                placeholder="Your full name"
                className="min-h-[44px]"
                error={errors.fullName?.message}
                {...register('fullName', { required: 'Full name is required', maxLength: { value: 100, message: 'Max 100 characters' } })}
              />
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                className="min-h-[44px]"
                error={errors.email?.message}
                {...register('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email' } })}
              />
              <div>
                <label htmlFor="join-linkedin" className="block text-sm font-medium text-gray-600 mb-1.5">LinkedIn profile (optional)</label>
                <div
                  className={`flex items-center min-h-[44px] rounded-xl border bg-gray-50 overflow-hidden focus-within:ring-2 focus-within:ring-[#1a1a2e] transition-all duration-200 ${errors.linkedinUrl ? 'border-red-500' : 'border-gray-200'}`}
                >
                  <span className="pl-4 pr-1 text-sm text-gray-400 whitespace-nowrap select-none">linkedin.com/in/</span>
                  <input
                    id="join-linkedin"
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={errors.linkedinUrl ? true : undefined}
                    aria-describedby={errors.linkedinUrl ? 'join-linkedin-error' : 'join-linkedin-help'}
                    {...register('linkedinUrl', {
                      validate: (value) => normalizeLinkedinInput(value) !== null || LINKEDIN_LINK_HELP,
                    })}
                    placeholder="your-username"
                    className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-base sm:text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
                {errors.linkedinUrl ? (
                  <p id="join-linkedin-error" className="text-xs text-red-500 mt-1">{errors.linkedinUrl.message}</p>
                ) : (
                  <p id="join-linkedin-help" className="text-xs text-gray-500 mt-1">Recommended. You can also add it later.</p>
                )}
              </div>
              <div>
                <label htmlFor="join-reason" className="block text-sm font-medium text-gray-600 mb-1.5">Why do you want to join REASON?</label>
                <textarea
                  id="join-reason"
                  rows={4}
                  aria-invalid={errors.reason ? true : undefined}
                  {...register('reason', {
                    required: REASON_REQUIRED,
                    maxLength: { value: 1000, message: 'Max 1000 characters' },
                    validate: (value) => value.trim() !== '' || REASON_REQUIRED,
                  })}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-base sm:text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
                />
                {errors.reason && <p className="text-xs text-red-500 mt-1">{errors.reason.message}</p>}
              </div>

              <Button type="submit" className="w-full group" isLoading={isSubmitting}>
                Submit Request
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Button>
            </form>

            <p className="text-xs text-gray-500 text-center mt-4">
              Your application will be reviewed by the REASON team. You&apos;ll receive an email with the outcome.
            </p>
          </div>
        ) : (
          <div role="status" className="rounded-2xl border border-gray-200 bg-gray-50/60 p-5 sm:p-8 text-center space-y-4 animate-fade-in">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-50 text-emerald-600 mb-2">
              <CheckCircle className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-semibold text-[#1a1a2e]">Request Submitted</h2>
            <p className="text-gray-500 text-sm">
              Thank you for your interest in REASON. We&apos;ll review your application and get back to you by email.
            </p>
            <p className="text-gray-500 text-xs">This usually takes 1-3 business days.</p>
          </div>
        )}

        {/* Back links */}
        <div className="flex flex-wrap items-center justify-center gap-x-6 mt-6 text-sm">
          <button onClick={() => navigate('/welcome')} className="min-h-[44px] text-gray-500 hover:text-[#1a1a2e] transition-colors inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" /> Back to REASON
          </button>
          <button onClick={() => navigate('/login')} className="min-h-[44px] inline-flex items-center text-gray-500 hover:text-[#1a1a2e] transition-colors">
            Already have access? Sign in
          </button>
        </div>
      </div>
    </div>
  );
}
