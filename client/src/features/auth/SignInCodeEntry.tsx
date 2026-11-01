import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import { CODE_LENGTH, codeErrorMessage, digitsOf } from './sign-in-code';

// The 6-digit code from the sign-in email, typed on the waiting screen (1 Nov 2026). For a member who opened the email
// on another device or in a mail app's own browser, where the link signs in that browser instead of this one. A phone
// offers the code from the email above the keyboard (one-time-code); pasting the whole code, with a space or a dash in
// it, works; the code is sent by itself once all six digits are in.
export default function SignInCodeEntry({ email, onSignedIn }: { email: string; onSignedIn: () => void }) {
  const verifyCode = useAuthStore((s) => s.verifyCode);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, setValue, watch, formState: { isSubmitting } } = useForm<{ code: string }>({
    defaultValues: { code: '' },
  });
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const code = watch('code');
  const lastSent = useRef('');

  const submit = handleSubmit(async ({ code: typed }) => {
    if (typed.length !== CODE_LENGTH) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    lastSent.current = typed;
    setError(null);
    try {
      await verifyCode(email, typed);
      onSignedIn();
    } catch (err) {
      setError(codeErrorMessage(err));
    }
  });

  // Once all six digits are in (typed, pasted or filled by the phone), send them; the same six are not sent twice.
  useEffect(() => {
    if (code.length === CODE_LENGTH && code !== lastSent.current && !isSubmitting) void submit();
  }, [code, isSubmitting, submit]);

  return (
    <form onSubmit={submit} className="space-y-3 text-left" noValidate>
      <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700">6-digit code from the email</label>
      <input
        id={fieldId}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        placeholder="123456"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-full min-h-[52px] rounded-xl border border-gray-200 bg-white px-4 text-center font-mono text-[22px] font-semibold tracking-[0.35em] text-[#1a1a2e] placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
        {...register('code', { onChange: (e) => setValue('code', digitsOf(e.target.value)) })}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-600">{error}</p>
      )}
      <Button type="submit" className="w-full" isLoading={isSubmitting}>
        Sign in with this code
      </Button>
    </form>
  );
}
