// "Identify", second half (Part 2, Task 12): "Check your inbox for a 6-digit code". Six boxes (one field underneath, so
// the phone offers the code from the email and a paste works), sent by itself once six digits are in; the server's
// "tries left" on a wrong code; "Resend" after 30 seconds. The code's own UI is the sign-in page's (SignInCodeEntry).
//
// Once the code is proved, an event that does not take this address says so in its own words (403 from /verify, with
// details.admissionCode). The code stays valid: an invitation-only event shows the admission-code field here, and the same
// 6-digit code goes again with it. The email's button, when refused the same way, arrives here already proved.
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowRight, MailCheck } from 'lucide-react';
import SignInCodeEntry from '@/features/auth/SignInCodeEntry';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import {
  ADMISSION_CODE_DID_NOT_WORK, CALL_WORDS, admissionRefusalOf, emailFailure, enterFailure, verifyFailure,
  type AdmissionRefusal, type EntryFailure,
} from './call-entry';

const RESEND_WAIT_SECONDS = 30;

interface Props {
  /** The address the code went to; null when the email's own button proved it (no code was typed). */
  email: string | null;
  /** Development only: the code the local API hands back instead of emailing it. */
  devCode: string | null;
  /** Check the 6-digit code (null: the email's button), with an admission code when one was given. */
  verify: (code: string | null, admissionCode?: string) => Promise<void>;
  /** An admission code given at the email step, sent with the code. */
  carriedAdmissionCode: string;
  /** The email's button was refused by the event: start at the admission step. */
  initialRefusal?: AdmissionRefusal | null;
  resend: () => Promise<void>;
  onDifferentEmail: () => void;
  onClosed: (closed: NonNullable<EntryFailure['closed']>) => void;
}

interface Proved { code: string | null; refusal: AdmissionRefusal }

function AdmissionStep({ proved, carried, verify, onClosed, onDifferentEmail }: {
  proved: Proved;
  carried: string;
  verify: Props['verify'];
  onClosed: Props['onClosed'];
  onDifferentEmail: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ admissionCode: string }>({
    defaultValues: { admissionCode: carried },
  });
  const submit = handleSubmit(async ({ admissionCode }) => {
    setError(null);
    try {
      await verify(proved.code, admissionCode.trim());
    } catch (err) {
      if (admissionRefusalOf(err)) {
        setError(ADMISSION_CODE_DID_NOT_WORK);
        return;
      }
      // The admission code's own answer (used, expired, too many tries), in the server's words beside the field.
      const forCode = enterFailure(err);
      if (forCode.field === 'admissionCode') {
        setError(forCode.message);
        return;
      }
      const said = verifyFailure(err);
      if (said.closed) {
        onClosed(said.closed);
        return;
      }
      setError(said.message);
    }
  });

  return (
    <div className="space-y-4" data-testid="call-admission-step">
      <p role="alert" className="rounded-xl bg-reason-pink px-3.5 py-2.5 text-[14px] text-reason-red" data-testid="call-refusal">
        {proved.refusal.message}
      </p>
      {proved.refusal.askCode && (
        <form onSubmit={submit} noValidate className="space-y-3">
          <Input
            label="Admission code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="min-h-[48px] bg-white font-mono uppercase tracking-[0.08em]"
            error={errors.admissionCode?.message ?? error ?? undefined}
            {...register('admissionCode', {
              validate: (v) => (v.trim() ? true : 'Enter your admission code.'),
              maxLength: { value: 40, message: 'That admission code is too long.' },
            })}
          />
          <Button type="submit" size="lg" className="w-full rounded-2xl" isLoading={isSubmitting}>
            Continue
            {!isSubmitting && <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />}
          </Button>
        </form>
      )}
      <button type="button" onClick={onDifferentEmail} className="mx-auto flex min-h-[44px] items-center px-3 text-[14px] text-reason-muted hover:text-reason-ink">
        Use a different email
      </button>
    </div>
  );
}

export default function CallCodeStep({
  email, devCode, verify, carriedAdmissionCode, initialRefusal, resend, onDifferentEmail, onClosed,
}: Props) {
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  // A new code makes the one being typed useless: the boxes start again empty.
  const [round, setRound] = useState(0);
  const [proved, setProved] = useState<Proved | null>(initialRefusal ? { code: null, refusal: initialRefusal } : null);

  // The seconds left before another code may be asked for, shown on the button. A screen-only countdown.
  useEffect(() => {
    if (wait <= 0) return undefined;
    const tick = window.setTimeout(() => setWait((s) => s - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [wait]);

  const check = async (code: string) => {
    try {
      await verify(code, carriedAdmissionCode || undefined);
    } catch (err) {
      // A right code for an address the event does not take: not a failure of the code. Ask for what admits it.
      const refusal = admissionRefusalOf(err);
      if (refusal) {
        setProved({ code, refusal });
        return;
      }
      const said = verifyFailure(err);
      if (said.closed) onClosed(said.closed);
      throw err;
    }
  };

  const askAgain = async () => {
    if (wait > 0 || resending) return;
    setResending(true);
    setNotice(null);
    setResendError(null);
    try {
      await resend();
      setNotice('We sent a new code. Use the one in the newest email.');
      setRound((r) => r + 1);
      setProved(null);
      setWait(RESEND_WAIT_SECONDS);
    } catch (err) {
      const said = emailFailure(err);
      if (said.closed) {
        onClosed(said.closed);
        return;
      }
      setResendError(said.message);
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="call-code-step">
      <div>
        <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-[#e8f7ef] text-reason-green-fill">
          <MailCheck aria-hidden="true" className="h-6 w-6" />
        </div>
        <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em]">
          {proved ? 'Your email is confirmed' : CALL_WORDS.checkInbox}
        </h2>
        {!proved && email && (
          <p className="mt-1.5 break-words text-[15px] text-reason-muted">
            We sent it to <span className="font-semibold text-reason-ink">{email}</span>. It works for 15 minutes.
          </p>
        )}
      </div>

      {proved ? (
        <AdmissionStep proved={proved} carried={carriedAdmissionCode} verify={verify} onClosed={onClosed} onDifferentEmail={onDifferentEmail} />
      ) : (
        <>
          <SignInCodeEntry
            key={round}
            email={email ?? ''}
            boxes
            verify={check}
            errorOf={(err) => verifyFailure(err).message}
            submitLabel="Continue"
            onSignedIn={() => undefined}
          />

          {devCode && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-700">
              Development only: the code is <span className="font-mono font-bold">{devCode}</span>
            </p>
          )}
          {notice && <p role="status" className="text-[14px] text-reason-green-fill">{notice}</p>}
          {resendError && <p role="alert" className="text-[14px] text-red-600">{resendError}</p>}

          <div className="flex flex-col items-center gap-0.5 pt-1">
            <p className="text-[13px] text-reason-muted">Nothing yet? Check your spam folder.</p>
            <button
              type="button"
              onClick={askAgain}
              disabled={wait > 0 || resending}
              className="min-h-[44px] px-3 text-[14px] font-semibold text-reason-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-reason-muted disabled:no-underline"
            >
              {resending ? 'Sending…' : wait > 0 ? `Resend in ${wait}s` : 'Resend'}
            </button>
            <button type="button" onClick={onDifferentEmail} className="min-h-[44px] px-3 text-[14px] text-reason-muted hover:text-reason-ink">
              Use a different email
            </button>
          </div>
        </>
      )}
    </div>
  );
}
