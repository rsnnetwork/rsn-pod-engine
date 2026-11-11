// client/src/features/settings/CloseAccountDialog.tsx
// Close my account (Part 3 Task 7, the screen for Task 2's POST /users/me/close). It asks first, in words that say what
// closing does ("Close my account", destructive); only then "Confirm it's you" (a code to the current address,
// ReauthDialog, scope close_account); then the account is closed with that proof in the body, the member is signed out
// on this device (the server has already ended every session) and lands on `/`.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import api from '@/lib/api';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Sheet from '@/features/reason/ui/Sheet';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import ReauthDialog from './ReauthDialog';
import { REAUTH_API, REAUTH_WORDS, reauthScopeRequired, requestFailure, withProof } from './reauth';

interface Props { open: boolean; onClose: () => void }

export default function CloseAccountDialog({ open, onClose }: Props) {
  return open ? <CloseAccountFlow onClose={onClose} /> : null;
}

type Step = 'ask' | 'reauth' | 'closing';

function CloseAccountFlow({ onClose }: { onClose: () => void }) {
  const logout = useAuthStore((s) => s.logout);
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  // The question comes first: no code is asked for until the member has said they want to close.
  const [step, setStep] = useState<Step>('ask');

  const closeAccount = useMutation({
    mutationFn: (reauthToken: string) => api.post(REAUTH_API.close, withProof({}, reauthToken)),
    onSuccess: async () => {
      // The server has closed the account and ended every session: this device signs out too, and goes to the start.
      await logout();
      addToast(REAUTH_WORDS.closed, 'info');
      navigate('/', { replace: true });
    },
    onError: (err) => {
      if (reauthScopeRequired(err)) {
        setStep('reauth');
        return;
      }
      addToast(requestFailure(err), 'error');
      onClose();
    },
  });

  if (step === 'ask') {
    return (
      <ConfirmDialog
        open
        title={REAUTH_WORDS.closeTitle}
        body={REAUTH_WORDS.closeBody}
        confirmLabel={REAUTH_WORDS.closeConfirm}
        tone="danger"
        onConfirm={() => setStep('reauth')}
        onCancel={onClose}
      />
    );
  }

  if (step === 'reauth') {
    return (
      <ReauthDialog
        open
        scope="close_account"
        onConfirmed={(token) => { setStep('closing'); closeAccount.mutate(token); }}
        onCancel={onClose}
      />
    );
  }

  return (
    // While the account closes nothing else can be pressed: Escape, the backdrop and the close button wait.
    <Sheet open onClose={() => undefined} title={REAUTH_WORDS.closeTitle}>
      <p role="status" className="flex min-h-[44px] items-center gap-2 pb-2 text-[14px] text-[#454b55]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {REAUTH_WORDS.closing}
      </p>
    </Sheet>
  );
}
