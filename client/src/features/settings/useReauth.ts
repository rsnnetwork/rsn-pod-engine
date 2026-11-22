// ─── Ask for a fresh proof from inside a change (Part 3 Task 7) ─────────────────────────────────────────────────────
//
// For a screen whose change may need "Confirm it's you" (the admin role menus): `withReauth` sends the change, opening
// ReauthDialog first when the change is known to need a proof, or when the server answers REAUTH_REQUIRED, and then sends
// it again with the token (reauth.ts, sendWithReauth). The screen renders <ReauthDialog {...reauth.dialog} /> once.

import { useCallback, useRef, useState } from 'react';
import type { ReauthScope } from '@rsn/shared';
import { sendWithReauth } from './reauth';

export interface ReauthDialogControl {
  open: boolean;
  scope: ReauthScope;
  onConfirmed: (reauthToken: string) => void;
  onCancel: () => void;
}

export function useReauth() {
  const [scope, setScope] = useState<ReauthScope | null>(null);
  // The change waiting on the dialog. In a ref, so the dialog's answer reaches the change that asked, whatever rendered since.
  const waiting = useRef<((token: string | null) => void) | null>(null);

  const settle = useCallback((token: string | null) => {
    const answer = waiting.current;
    waiting.current = null;
    setScope(null);
    answer?.(token);
  }, []);

  const ask = useCallback((wanted: ReauthScope) => new Promise<string | null>((resolve) => {
    // One dialog at a time: a change still waiting is answered "cancelled" before the next asks.
    waiting.current?.(null);
    waiting.current = resolve;
    setScope(wanted);
  }), []);

  const withReauth = useCallback(
    <T,>(wanted: ReauthScope, askFirst: boolean, send: (reauthToken?: string) => Promise<T>) =>
      sendWithReauth({ scope: wanted, askFirst, ask, send }),
    [ask],
  );

  const dialog: ReauthDialogControl = {
    open: scope !== null,
    scope: scope ?? 'admin_role',
    onConfirmed: (token) => settle(token),
    onCancel: () => settle(null),
  };

  return { withReauth, dialog };
}
