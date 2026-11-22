// "Identify", first half (Part 2, Task 12; spec 02, 04): one field, the email, and "Send me a code". An invitation-only
// event also offers "Admission code (if you have one)", kept on the page and sent with the 6-digit code. The server answers
// every address the same, so the next step is always "Check your inbox for a 6-digit code"; whether this address may come
// in is said only after the code.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowLeft, Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { CALL_WORDS, emailFailure, type EntryFailure } from './call-entry';

interface EmailForm { email: string; admissionCode: string }

interface Props {
  /** The event offers the admission code field (invitation only). */
  asksAdmissionCode: boolean;
  defaults: { email: string; admissionCode: string };
  /** Said above the form: why they are here again (the email's link no longer works). */
  notice?: string | null;
  send: (input: { email: string; admissionCode?: string }) => Promise<void>;
  /** The event is over or the link leads nowhere: the page shows that instead. */
  onClosed: (closed: NonNullable<EntryFailure['closed']>) => void;
  onBack: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CallEmailStep({ asksAdmissionCode, defaults, notice, send, onClosed, onBack }: Props) {
  const [failure, setFailure] = useState<EntryFailure | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<EmailForm>({ defaultValues: defaults });

  const onSubmit = handleSubmit(async ({ email, admissionCode }) => {
    setFailure(null);
    try {
      await send({ email: email.trim(), admissionCode: admissionCode.trim() || undefined });
    } catch (err) {
      const said = emailFailure(err);
      if (said.closed) {
        onClosed(said.closed);
        return;
      }
      setFailure(said);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid="call-email-step">
      <div>
        <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em]">Enter your email</h2>
        <p className="mt-1.5 text-[15px] text-reason-muted">
          We&apos;ll send you a 6-digit code. No password, and no profile to fill in.
        </p>
      </div>
      {notice && <p role="status" className="rounded-xl bg-[#fff5e6] px-3.5 py-2.5 text-[14px] text-[#8a560f]">{notice}</p>}
      <Input
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="you@example.com"
        className="min-h-[48px] bg-white"
        error={errors.email?.message ?? (failure?.field === 'email' ? failure.message : undefined)}
        {...register('email', {
          required: 'Enter your email address.',
          pattern: { value: EMAIL_PATTERN, message: 'Enter a valid email address.' },
          maxLength: { value: 255, message: 'Enter a valid email address.' },
        })}
      />
      {asksAdmissionCode && (
        <Input
          label={CALL_WORDS.admissionCodeLabel}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="min-h-[48px] bg-white font-mono uppercase tracking-[0.08em]"
          error={errors.admissionCode?.message}
          {...register('admissionCode', { maxLength: { value: 40, message: 'That admission code is too long.' } })}
        />
      )}
      {failure && failure.field !== 'email' && (
        <p role="alert" className="rounded-xl bg-reason-pink px-3.5 py-2.5 text-[14px] text-reason-red">{failure.message}</p>
      )}
      <Button type="submit" size="lg" className="w-full rounded-2xl" isLoading={isSubmitting}>
        {!isSubmitting && <Mail aria-hidden="true" className="mr-2 h-4 w-4" />}
        {CALL_WORDS.sendCode}
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="mx-auto flex min-h-[44px] items-center gap-1.5 px-3 text-[14px] font-semibold text-reason-muted hover:text-reason-ink"
      >
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to the event
      </button>
    </form>
  );
}
