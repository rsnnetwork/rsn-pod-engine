// client/src/features/settings/ReauthDialog.tsx
// "Confirm it's you" (10 Nov 2026 spec, section 11; Part 3 Task 7). Before a sensitive change: where the code goes and
// a "Send code" button, then the 6-digit code from that email (SignInCodeEntry, checked through its `verify` prop
// against POST /auth/reauth/verify), then the reauth token is handed to the change that asked. A bottom sheet on phones,
// a centred dialog from 768px, portalled to <body> with its focus kept inside (Sheet).
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ReauthScope } from '@rsn/shared';
import api from '@/lib/api';
import Sheet from '@/features/reason/ui/Sheet';
import SignInCodeEntry from '@/features/auth/SignInCodeEntry';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { FRESH_CODE, REAUTH_API, REAUTH_WORDS, askSentence, codeFailure, requestFailure, sentSentence } from './reauth';

interface Props {
  open: boolean;
  scope: ReauthScope;
  /** The proof, once the code is right. Good for one change of this kind, for ten minutes. */
  onConfirmed: (reauthToken: string) => void;
  onCancel: () => void;
}

export const DIALOG_BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-4 text-[14px] font-bold disabled:opacity-60';

export default function ReauthDialog({ open, ...rest }: Props) {
  // Mounted only while open, so every opening starts at the first step with nothing left from the last one.
  return open ? <ReauthSheet {...rest} /> : null;
}

function ReauthSheet({ scope, onConfirmed, onCancel }: Omit<Props, 'open'>) {
  const email: string = useAuthStore((s) => s.user?.email ?? '');
  const token = useRef<string | null>(null);
  // Once the first code is on its way the code field stays, also while a new code is asked for.
  const [sent, setSent] = useState(false);

  const send = useMutation({
    mutationFn: () => api.post(REAUTH_API.code, { scope }),
    onSuccess: () => setSent(true),
  });

  const verify = async (code: string) => {
    const { data } = await api.post(REAUTH_API.verify, { scope, code });
    token.current = data.data.reauthToken as string;
  };

  const cancel = () => { if (!send.isPending) onCancel(); };

  return (
    <Sheet
      open
      onClose={cancel}
      title={REAUTH_WORDS.title}
      footer={sent ? undefined : (
        <>
          <button type="button" onClick={cancel} disabled={send.isPending} className={cn(DIALOG_BUTTON, 'border border-reason-line bg-white text-reason-ink')}>
            {REAUTH_WORDS.cancel}
          </button>
          <button
            type="button"
            onClick={() => send.mutate()}
            disabled={send.isPending}
            aria-busy={send.isPending}
            data-testid="reauth-send"
            className={cn(DIALOG_BUTTON, 'bg-reason-ink text-white enabled:hover:opacity-90')}
          >
            {send.isPending ? 'Sending…' : REAUTH_WORDS.send}
          </button>
        </>
      )}
    >
      <div className="space-y-3 pb-1 pt-1" data-testid="reauth-dialog">
        <p className="text-[14px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">
          {sent ? sentSentence(email) : askSentence(email)}
        </p>
        {send.isError && (
          <p role="alert" className="text-sm text-red-600">{requestFailure(send.error)}</p>
        )}
        {sent && (
          <>
            <SignInCodeEntry
              email={email}
              verify={verify}
              onSignedIn={() => { if (token.current) onConfirmed(token.current); }}
              errorOf={(err) => codeFailure(err, FRESH_CODE)}
              submitLabel={REAUTH_WORDS.confirm}
            />
            <button
              type="button"
              onClick={() => send.mutate()}
              disabled={send.isPending}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl text-sm font-medium text-reason-ink underline-offset-2 hover:underline disabled:opacity-60"
            >
              {send.isPending ? 'Sending…' : REAUTH_WORDS.sendAgain}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
