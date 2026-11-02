import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';

/** How long the page says it is retrying before it offers a way out: never a dead end (CLAUDE.md §12). */
export const OFFER_CHOICES_AFTER_MS = 20_000;

interface ChoicesProps {
  trying: boolean;
  signingOut: boolean;
  onTryAgain: () => void;
  onSignOut: () => void;
}

/** Try again (asks at once, the waits start again from the first) and Sign out. One column on a phone. */
export function SessionRetryingChoices({ trying, signingOut, onTryAgain, onSignOut }: ChoicesProps) {
  return (
    <div className="flex w-full max-w-xs flex-col gap-2 sm:max-w-sm sm:flex-row sm:justify-center">
      <Button
        data-testid="session-try-again"
        className="w-full sm:w-auto sm:min-w-[9rem]"
        isLoading={trying}
        disabled={signingOut}
        aria-busy={trying}
        onClick={onTryAgain}
      >
        Try again
      </Button>
      <Button
        data-testid="session-sign-out"
        variant="outline"
        className="w-full sm:w-auto sm:min-w-[9rem]"
        isLoading={signingOut}
        disabled={trying}
        aria-busy={signingOut}
        onClick={onSignOut}
      >
        Sign out
      </Button>
    </div>
  );
}

/**
 * What the protected page says while the session check waits out a 429, a 5xx or no connection (fix wave 3, 2 Nov
 * 2026): the member stays signed in. After about 20 seconds it also offers Try again and Sign out (429 fix round 1).
 */
export default function SessionRetrying() {
  const retrySessionNow = useAuthStore((s) => s.retrySessionNow);
  const logout = useAuthStore((s) => s.logout);
  const [offerChoices, setOfferChoices] = useState(false);
  const [trying, setTrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const reveal = setTimeout(() => setOfferChoices(true), OFFER_CHOICES_AFTER_MS);
    return () => clearTimeout(reveal);
  }, []);

  const tryAgain = () => {
    if (trying || signingOut) return;
    setTrying(true);
    void retrySessionNow().finally(() => setTrying(false));
  };
  const signOut = () => {
    if (trying || signingOut) return;
    setSigningOut(true);
    // logout() never rejects; once it has run, the protected page sends the member to sign in.
    void logout();
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <p data-testid="session-retrying" role="status" className="text-sm text-gray-500">Connection lost, retrying…</p>
      {offerChoices && (
        <SessionRetryingChoices trying={trying} signingOut={signingOut} onTryAgain={tryAgain} onSignOut={signOut} />
      )}
    </div>
  );
}
