// client/src/features/settings/ChangeEmailDialog.tsx
// Change the sign-in email (Part 3 Task 7, the screens for Task 2). Three steps:
//   1. "Confirm it's you": a code to the current address (ReauthDialog, scope change_email);
//   2. "New email address": a code to the new address (POST /users/me/email/code with the proof in the body);
//   3. "We sent a code to {new}. Type it to finish.": the change (POST /users/me/email/verify). The server ends every
//      other session and answers a fresh token pair, which the auth store installs; the session read then shows the new
//      address, and user:<id> brings the member's other screens along without a reload.
// A refused new address (already yours, taken, can't receive email) has spent its proof (Task 2 ruling 7): the next
// try asks for a new one, and the address typed is sent as soon as it is confirmed.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import api from '@/lib/api';
import Sheet from '@/features/reason/ui/Sheet';
import SignInCodeEntry from '@/features/auth/SignInCodeEntry';
import { formResolver } from '@/lib/form-resolver';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import ReauthDialog, { DIALOG_BUTTON } from './ReauthDialog';
import {
  FRESH_EMAIL_CODE, REAUTH_API, REAUTH_WORDS, codeFailure, emailChangedToast, newEmailCodeSentence, proofSpentBy,
  reauthScopeRequired, requestFailure, withProof,
} from './reauth';

interface Props { open: boolean; onClose: () => void }

const newEmailSchema = z.object({
  newEmail: z.string().trim().min(1, 'Enter your new email address.').max(255, 'That address is too long.')
    .email('Enter a valid email address.').transform((e) => e.toLowerCase()),
});
type NewEmail = z.infer<typeof newEmailSchema>;

export default function ChangeEmailDialog({ open, onClose }: Props) {
  return open ? <ChangeEmailFlow onClose={onClose} /> : null;
}

type Step = 'reauth' | 'email' | 'code';

function ChangeEmailFlow({ onClose }: { onClose: () => void }) {
  const setTokensAndLoad = useAuthStore((s) => s.setTokensAndLoad);
  const addToast = useToastStore((s) => s.addToast);
  const [step, setStep] = useState<Step>('reauth');
  const [proof, setProof] = useState<string | null>(null);
  /** The address waiting for a proof: sent the moment the member has confirmed it's them. */
  const [waiting, setWaiting] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState('');
  const form = useForm<NewEmail>({ resolver: formResolver(newEmailSchema), defaultValues: { newEmail: '' } });
  const fieldError = form.formState.errors.newEmail?.message;

  const sendCode = useMutation({
    mutationFn: ({ newEmail, reauthToken }: { newEmail: string; reauthToken: string }) =>
      api.post(REAUTH_API.emailCode, withProof({ newEmail }, reauthToken)),
    onSuccess: (_res, { newEmail }) => {
      // The proof is spent: a new address from here needs a new one.
      setProof(null);
      setSentTo(newEmail);
      setStep('code');
    },
    onError: (err, { newEmail }) => {
      if (reauthScopeRequired(err)) {
        setProof(null);
        setWaiting(newEmail);
        setStep('reauth');
        return;
      }
      if (proofSpentBy(err)) setProof(null);
      setStep('email');
      form.setError('newEmail', { message: requestFailure(err) });
    },
  });

  const submit = form.handleSubmit(({ newEmail }) => {
    if (sendCode.isPending) return;
    if (!proof) {
      setWaiting(newEmail);
      setStep('reauth');
      return;
    }
    sendCode.mutate({ newEmail, reauthToken: proof });
  });

  const confirmed = (token: string) => {
    if (waiting) {
      const newEmail = waiting;
      setWaiting(null);
      setStep('email');
      sendCode.mutate({ newEmail, reauthToken: token });
      return;
    }
    setProof(token);
    setStep('email');
  };

  const verify = async (code: string) => {
    const { data } = await api.post(REAUTH_API.emailVerify, { code });
    // Every other session ended with the change; this one goes on with the pair the server answered.
    await setTokensAndLoad(data.data.accessToken as string, data.data.refreshToken as string);
  };

  const close = () => { if (!sendCode.isPending) onClose(); };

  if (step === 'reauth') {
    return <ReauthDialog open scope="change_email" onConfirmed={confirmed} onCancel={close} />;
  }

  return (
    <Sheet open onClose={close} title={REAUTH_WORDS.changeEmail}>
      <div className="space-y-3 pb-1 pt-1" data-testid="change-email-dialog">
        {step === 'email' ? (
          <form onSubmit={submit} noValidate className="space-y-3">
            <label htmlFor="change-email-new" className="block text-sm font-medium text-gray-700">{REAUTH_WORDS.newEmailLabel}</label>
            <input
              id="change-email-new"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'change-email-new-error' : undefined}
              className="min-h-[48px] w-full rounded-xl border border-gray-200 bg-white px-4 text-[16px] text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
              {...form.register('newEmail')}
            />
            {fieldError && <p id="change-email-new-error" role="alert" className="text-sm text-red-600 [overflow-wrap:anywhere]">{fieldError}</p>}
            <div className="flex flex-col-reverse gap-2 min-[400px]:flex-row min-[400px]:justify-end">
              <button type="button" onClick={close} disabled={sendCode.isPending} className={cn(DIALOG_BUTTON, 'border border-reason-line bg-white text-reason-ink')}>
                {REAUTH_WORDS.cancel}
              </button>
              <button
                type="submit"
                disabled={sendCode.isPending}
                aria-busy={sendCode.isPending}
                data-testid="change-email-send"
                className={cn(DIALOG_BUTTON, 'bg-reason-ink text-white enabled:hover:opacity-90')}
              >
                {sendCode.isPending ? 'Sending…' : REAUTH_WORDS.newEmailSend}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-[14px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">{newEmailCodeSentence(sentTo)}</p>
            <SignInCodeEntry
              email={sentTo}
              verify={verify}
              onSignedIn={() => { addToast(emailChangedToast(sentTo), 'success'); onClose(); }}
              errorOf={(err) => codeFailure(err, FRESH_EMAIL_CODE)}
              submitLabel={REAUTH_WORDS.finishEmail}
            />
            <button
              type="button"
              onClick={() => setStep('email')}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl text-sm font-medium text-reason-ink underline-offset-2 hover:underline"
            >
              {REAUTH_WORDS.startAgain}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
