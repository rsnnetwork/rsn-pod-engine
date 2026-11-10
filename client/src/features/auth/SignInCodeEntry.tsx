import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { CODE_LENGTH, codeErrorMessage, digitsOf } from './sign-in-code';

interface Props {
  email: string;
  onSignedIn: () => void;
  /**
   * How the code is checked. The sign-in page leaves it out (POST /auth/magic-link/code); an event's RSN Call link
   * (Part 2, Task 12) checks it against that event's entry code instead. A failure is thrown, and worded below.
   */
  verify?: (code: string) => Promise<void>;
  /** The sentence for a refused code; the sign-in code's words when left out. */
  errorOf?: (err: unknown) => string;
  /** Six boxes, one per digit (the call link), instead of one wide field. Still one field underneath. */
  boxes?: boolean;
  submitLabel?: string;
}

// The 6-digit code from the sign-in email, typed on the waiting screen (1 Nov 2026). For a member who opened the email
// on another device or in a mail app's own browser, where the link signs in that browser instead of this one. A phone
// offers the code from the email above the keyboard (one-time-code); pasting the whole code, with a space or a dash in
// it, works; the code is sent by itself once all six digits are in.
export default function SignInCodeEntry({ email, onSignedIn, verify, errorOf, boxes = false, submitLabel = 'Sign in with this code' }: Props) {
  const verifyCode = useAuthStore((s) => s.verifyCode);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
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
      if (verify) await verify(typed);
      else await verifyCode(email, typed);
      onSignedIn();
    } catch (err) {
      setError(errorOf ? errorOf(err) : codeErrorMessage(err));
    }
  });

  // Once all six digits are in (typed, pasted or filled by the phone), send them; the same six are not sent twice.
  useEffect(() => {
    if (code.length === CODE_LENGTH && code !== lastSent.current && !isSubmitting) void submit();
  }, [code, isSubmitting, submit]);

  const field = register('code', { onChange: (e) => setValue('code', digitsOf(e.target.value)) });
  const described = {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const;

  return (
    <form onSubmit={submit} className="space-y-3 text-left" noValidate>
      <label htmlFor={fieldId} className="block text-sm font-medium text-gray-700">6-digit code from the email</label>
      {boxes ? (
        // One real field over six drawn boxes: the phone's one-time-code fill, a paste and a screen reader all meet a
        // single input. Its own text is transparent; the boxes show the digits. 16px or more, so iOS does not zoom.
        <div className="relative" data-testid="code-boxes">
          <div aria-hidden="true" className="grid grid-cols-6 gap-1.5 min-[400px]:gap-2">
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <div
                key={i}
                className={cn(
                  'flex h-14 min-w-[44px] items-center justify-center rounded-xl border bg-white font-mono text-[24px] font-semibold text-reason-ink transition-colors',
                  error ? 'border-red-400' : 'border-gray-300',
                  focused && (i === Math.min(code.length, CODE_LENGTH - 1)) && 'border-reason-ink ring-2 ring-reason-ink/15',
                )}
              >
                {code[i] ?? ''}
              </div>
            ))}
          </div>
          <input
            id={fieldId}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH + 4}
            {...described}
            className="absolute inset-0 h-full w-full cursor-text rounded-xl bg-transparent text-[16px] text-transparent caret-transparent outline-none selection:bg-transparent"
            {...field}
            onFocus={() => setFocused(true)}
            onBlur={(e) => { setFocused(false); void field.onBlur(e); }}
          />
        </div>
      ) : (
        <input
          id={fieldId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          placeholder="123456"
          {...described}
          className="w-full min-h-[52px] rounded-xl border border-gray-200 bg-white px-4 text-center font-mono text-[22px] font-semibold tracking-[0.35em] text-[#1a1a2e] placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
          {...field}
        />
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-600">{error}</p>
      )}
      <Button type="submit" className="w-full" isLoading={isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
