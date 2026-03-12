import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { ArrowRight, CheckCircle, ArrowLeft } from 'lucide-react';
import api from '@/lib/api';

interface RequestForm {
  fullName: string;
  email: string;
  linkedinUrl: string;
  reason: string;
}

export default function RequestToJoinPage() {
  const navigate = useNavigate();
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RequestForm>();

  const onSubmit = async (data: RequestForm) => {
    setSubmitError(null);
    try {
      await api.post('/join-requests', data);
      setSubmitted(true);
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Failed to submit request. Please try again.';
      setSubmitError(msg);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4 font-display">
      <div className="w-full max-w-lg animate-fade-in-up">
        {/* RSN Logo + Header */}
        <div className="text-center mb-10">
          <img src="/rsn-logo.png" alt="RSN" className="h-14 w-auto mx-auto mb-6 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/welcome')} />
          <h1 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] tracking-tight">REQUEST TO JOIN</h1>
          <p className="text-gray-400 text-sm mt-2 tracking-wide">RSN is invite-only. Tell us about yourself.</p>
        </div>

        {!submitted ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-8">
            {submitError && (
              <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200">
                <p className="text-sm text-red-600">{submitError}</p>
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              <Input
                label="Full Name"
                placeholder="Your full name"
                error={errors.fullName?.message}
                {...register('fullName', { required: 'Full name is required', maxLength: { value: 100, message: 'Max 100 characters' } })}
              />
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                error={errors.email?.message}
                {...register('email', { required: 'Email is required', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email' } })}
              />
              <Input
                label="LinkedIn Profile"
                placeholder="https://linkedin.com/in/your-profile"
                error={errors.linkedinUrl?.message}
                {...register('linkedinUrl', { required: 'LinkedIn profile is required', pattern: { value: /^https?:\/\/(www\.)?linkedin\.com\/in\/.+/i, message: 'Enter a valid LinkedIn profile URL' } })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Why do you want to join RSN?</label>
                <textarea
                  {...register('reason', { required: 'Please tell us why you want to join', maxLength: { value: 1000, message: 'Max 1000 characters' } })}
                  rows={4}
                  placeholder="Tell us about yourself and why you'd be a great fit for the RSN community..."
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
                />
                {errors.reason && <p className="text-xs text-red-500 mt-1">{errors.reason.message}</p>}
              </div>

              <Button type="submit" className="w-full group" isLoading={isSubmitting}>
                Submit Request
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Button>
            </form>

            <p className="text-xs text-gray-400 text-center mt-4">
              Your application will be reviewed by the RSN team. You&apos;ll receive an email with the outcome.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-8 text-center space-y-4 animate-fade-in">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-50 text-emerald-600 mb-2">
              <CheckCircle className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-semibold text-[#1a1a2e]">Request Submitted</h2>
            <p className="text-gray-500 text-sm">
              Thank you for your interest in RSN. We&apos;ll review your application and get back to you via email.
            </p>
            <p className="text-gray-400 text-xs">This usually takes 1-3 business days.</p>
          </div>
        )}

        {/* Back links */}
        <div className="flex items-center justify-center gap-6 mt-6 text-sm">
          <button onClick={() => navigate('/welcome')} className="text-gray-400 hover:text-[#1a1a2e] transition-colors inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" /> Back to RSN
          </button>
          <button onClick={() => navigate('/login')} className="text-gray-400 hover:text-[#1a1a2e] transition-colors">
            Already have access? Sign in
          </button>
        </div>
      </div>
    </div>
  );
}
