// ─── Confirm it's you: the rules and words the dialogs share (10 Nov 2026 spec, Part 3 Task 7) ─────────────────────
//
// Section 11 of the spec: "Verify identity again for sensitive changes." Before a member changes their sign-in email,
// closes their own account, or (an admin) grants or removes an admin role, the server wants a fresh proof: a 6-digit code
// emailed to the member's current address, typed, and swapped for a short reauth token (Task 2). The token is spent by
// the one change it is sent with, in the JSON body as `reauthToken`; a change without one is refused with 403
// REAUTH_REQUIRED, and error.details.scope names the proof it needs.
//
// No imports but the shared types, so the server's test suite can run it.

import type { ReauthScope } from '@rsn/shared';

/** The only routes the confirm-it's-you, change email and close account dialogs call (Task 2). */
export const REAUTH_API = {
  /** { scope } → { sent: true }: a code to the member's current address. */
  code: '/auth/reauth/code',
  /** { scope, code } → { reauthToken, expiresAt }. */
  verify: '/auth/reauth/verify',
  /** { newEmail, reauthToken } → { sent: true }: a code to the new address. */
  emailCode: '/users/me/email/code',
  /** { code } → { accessToken, refreshToken, expiresAt }: the change made, every other session ended. */
  emailVerify: '/users/me/email/verify',
  /** { reauthToken } → { closed: true }. */
  close: '/users/me/close',
} as const;

export const REAUTH_WORDS = {
  title: "Confirm it's you",
  send: 'Send code',
  sendAgain: 'Send a new code',
  confirm: 'Confirm',
  cancel: 'Cancel',
  changeEmail: 'Change email',
  newEmailLabel: 'New email address',
  newEmailSend: 'Send code to this address',
  finishEmail: 'Change my email',
  startAgain: 'Use a different email',
  closeAccount: 'Close account',
  closeTitle: 'Close your account?',
  closeBody: "You'll be signed out everywhere and removed from your pods and events. To come back you'll need to apply again.",
  closeConfirm: 'Close my account',
  closing: 'Closing your account…',
  closed: 'Your account is closed.',
} as const;

/** The first step's sentence: where the code goes. */
export function askSentence(email: string): string {
  return `To keep your account safe we'll send a code to ${email || 'your email'}.`;
}

/** The second step's sentence, once the code is on its way. */
export function sentSentence(email: string): string {
  return `We sent a code to ${email || 'your email'}. Type it to confirm it's you.`;
}

/** The change-email step after the new address was given. */
export function newEmailCodeSentence(newEmail: string): string {
  return `We sent a code to ${newEmail}. Type it to finish.`;
}

export function emailChangedToast(newEmail: string): string {
  return `Your sign-in email is now ${newEmail}.`;
}

/** A request body with the proof in it, when there is one. The proof travels in the JSON body, never in a header. */
export function withProof<T extends object>(body: T, reauthToken?: string | null): T & { reauthToken?: string } {
  return reauthToken ? { ...body, reauthToken } : body;
}

interface ApiFailure {
  response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown; details?: { scope?: unknown; attemptsLeft?: unknown } } } };
}

const errorOf = (err: unknown) => (err as ApiFailure | null)?.response?.data?.error;

/** The proof a refused change asks for (403 REAUTH_REQUIRED, error.details.scope), or null for any other answer. */
export function reauthScopeRequired(err: unknown): ReauthScope | null {
  const error = errorOf(err);
  if (error?.code !== 'REAUTH_REQUIRED') return null;
  const scope = error.details?.scope;
  return scope === 'change_email' || scope === 'close_account' || scope === 'admin_role' ? scope : null;
}

/** The member closed the confirm-it's-you dialog: nothing was sent, and nothing needs saying. */
export class ReauthCancelled extends Error {
  constructor() {
    super('Confirmation cancelled');
    this.name = 'ReauthCancelled';
  }
}

export function isReauthCancelled(err: unknown): boolean {
  return err instanceof ReauthCancelled;
}

/**
 * Send a change that may need a proof. With `askFirst` (the change is known to need one: an admin role) the dialog
 * comes first and the change goes with its token. Without it the change goes as it is, and only when the server answers
 * REAUTH_REQUIRED for this scope is the dialog opened and the change sent once more, with the token. A closed dialog
 * throws ReauthCancelled and nothing more is sent.
 */
export async function sendWithReauth<T>(opts: {
  scope: ReauthScope;
  askFirst: boolean;
  ask: (scope: ReauthScope) => Promise<string | null>;
  send: (reauthToken?: string) => Promise<T>;
}): Promise<T> {
  const { scope, askFirst, ask, send } = opts;
  const proof = async (): Promise<string> => {
    const token = await ask(scope);
    if (!token) throw new ReauthCancelled();
    return token;
  };
  if (askFirst) return send(await proof());
  try {
    return await send();
  } catch (err) {
    if (reauthScopeRequired(err) !== scope) throw err;
    return send(await proof());
  }
}

const PLAIN_FAILURE = 'That did not go through. Please try again.';
const NO_CONNECTION = 'Connection lost. Please check your connection and try again.';

/** The sentence for a refused request (asking for a code, the new address, closing): the server's own words, else a plain one. */
export function requestFailure(err: unknown): string {
  const failure = err as ApiFailure | null;
  if (!failure?.response) return NO_CONNECTION;
  const error = failure.response.data?.error;
  if (error?.code === 'INTERNAL_ERROR' || typeof error?.message !== 'string' || !error.message.trim()) return PLAIN_FAILURE;
  return error.message;
}

/** The sentence for a refused code. `fresh` says how to get a new one (a new code, or starting again). */
export function codeFailure(err: unknown, fresh: string): string {
  const failure = err as ApiFailure | null;
  if (failure && !failure.response && !(err instanceof ReauthCancelled)) return NO_CONNECTION;
  const error = errorOf(err);
  switch (error?.code) {
    case 'AUTH_SIGN_IN_CODE_WRONG': {
      const left = error.details?.attemptsLeft;
      if (typeof left !== 'number') return 'That code is not right. Check the newest email and try again.';
      return `That code is not right. You can try ${left} more ${left === 1 ? 'time' : 'times'}.`;
    }
    case 'AUTH_SIGN_IN_LOCKED':
      return `That code was entered wrongly too many times, so it no longer works. ${fresh}`;
    case 'AUTH_SIGN_IN_CODE_EXPIRED':
      return `This code has expired. ${fresh}`;
    case 'AUTH_MAGIC_LINK_USED':
      return `This code has already been used. ${fresh}`;
    case 'EMAIL_IN_USE':
      return 'That email is already used by another account.';
    case 'RATE_LIMIT_EXCEEDED':
      return typeof error.message === 'string' && error.message.trim() ? error.message : 'Too many codes tried. Please wait 15 minutes, then try again.';
    case 'VALIDATION_ERROR':
      return 'Enter the 6-digit code from the email.';
    default:
      return 'We could not check that code. Please try again.';
  }
}

/** How a member gets a fresh confirmation code, and a fresh code for a new address. */
export const FRESH_CODE = 'Send a new code.';
export const FRESH_EMAIL_CODE = 'Choose "Use a different email" to start again.';

/** The errors a new address can be refused with after its proof was spent (Task 2 ruling 7): the next try needs a new one. */
export function proofSpentBy(err: unknown): boolean {
  const failure = err as ApiFailure | null;
  if (!failure?.response) return false;
  const code = errorOf(err)?.code;
  return code !== 'VALIDATION_ERROR' && code !== 'RATE_LIMIT_EXCEEDED';
}
