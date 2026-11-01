import { useEffect, useState } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import SignInCodeEntry from './SignInCodeEntry';

const RESEND_WAIT_SECONDS = 30;

interface Props {
  email: string;
  /** Development only: the link the local API hands back instead of emailing it. */
  devLink: string | null;
  /** Ask for a new email (a new link and a new code; the older ones stop working). */
  onResend: () => Promise<void>;
  onDifferentEmail: () => void;
  onSignedIn: () => void;
}

function resendFailure(err: unknown): string {
  const message = (err as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
  return typeof message === 'string' && message ? message : 'We could not send a new email. Please try again.';
}

// The waiting screen after "Email me a link and a code" (1 Nov 2026). The link still continues this page when it is
// opened in this browser; the code works from anywhere. A new email can be asked for after a short wait.
export default function CheckEmailPanel({ email, devLink, onResend, onDifferentEmail, onSignedIn }: Props) {
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  // A new email makes the code being typed useless: the field starts again empty.
  const [round, setRound] = useState(0);

  // The seconds left before another email may be asked for, shown on the button. A screen-only countdown.
  useEffect(() => {
    if (wait <= 0) return undefined;
    const tick = window.setTimeout(() => setWait((s) => s - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [wait]);

  const resend = async () => {
    if (wait > 0 || resending) return;
    setResending(true);
    setNotice(null);
    setResendError(null);
    try {
      await onResend();
      setNotice('We sent a new email. Use the code in the newest one.');
      setRound((r) => r + 1);
      setWait(RESEND_WAIT_SECONDS);
    } catch (err) {
      setResendError(resendFailure(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-5 sm:p-8 text-center space-y-4 animate-fade-in">
      <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-50 text-emerald-600">
        <Mail className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-semibold text-[#1a1a2e]">Check your email</h2>
      <p className="text-gray-600 text-sm break-words">
        We sent a sign-in link and a 6-digit code to <span className="font-medium text-gray-800">{email}</span>
      </p>
      <p className="text-gray-500 text-xs">
        Open the link on this device, or type the code below. The link works for 60 minutes, the code for 15.
      </p>

      <SignInCodeEntry key={round} email={email} onSignedIn={onSignedIn} />

      <p className="text-gray-400 text-xs">Opened the link in this browser? This page continues by itself.</p>

      {devLink && (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 animate-fade-in">
          <p className="text-xs text-amber-600 mb-2 font-semibold">DEV MODE — Direct Link</p>
          <a href={devLink} className="inline-flex min-h-[44px] items-center gap-2 text-sm text-amber-600 hover:text-amber-700 underline">
            Click here to verify
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      )}

      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {resendError && <p role="alert" className="text-sm text-red-600">{resendError}</p>}

      <div className="flex flex-col items-center gap-1 pt-1">
        <p className="text-xs text-gray-400">Nothing yet? Check your spam folder.</p>
        <button
          type="button"
          onClick={resend}
          disabled={wait > 0 || resending}
          className="min-h-[44px] px-3 text-sm font-medium text-[#1a1a2e] underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline"
        >
          {resending ? 'Sending…' : wait > 0 ? `Send a new email in ${wait}s` : 'Send a new email'}
        </button>
        <button type="button" onClick={onDifferentEmail} className="min-h-[44px] px-3 text-sm text-gray-500 hover:text-gray-700 transition-colors">
          Try a different email
        </button>
      </div>
    </div>
  );
}
