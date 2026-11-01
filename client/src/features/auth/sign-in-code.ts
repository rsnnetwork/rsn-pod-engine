// The 6-digit sign-in code from the sign-in email (1 Nov 2026): what the waiting screen keeps of what is typed or
// pasted, and what it says when the server refuses a code. No imports, so the server's test suite can run it.

export const CODE_LENGTH = 6;

/** Only the digits, at most six: "123 456", "123-456" and a pasted "Your code: 123456." all become 123456. */
export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

const SEND_AGAIN = 'Send a new email to get a fresh code.';

interface ApiFailure {
  response?: { data?: { error?: { code?: string; details?: { attemptsLeft?: unknown } } } };
}

/** The sentence for a refused code. Never a code, a status or "Network Error". */
export function codeErrorMessage(err: unknown): string {
  const error = (err as ApiFailure | null)?.response?.data?.error;
  switch (error?.code) {
    case 'AUTH_SIGN_IN_CODE_WRONG': {
      const left = error.details?.attemptsLeft;
      if (typeof left !== 'number') return 'That code is not right. Check the newest email and try again.';
      return `That code is not right. You can try ${left} more ${left === 1 ? 'time' : 'times'}.`;
    }
    case 'AUTH_SIGN_IN_LOCKED':
      return `That code was entered wrongly too many times, so it and the link no longer work. ${SEND_AGAIN}`;
    case 'AUTH_SIGN_IN_CODE_EXPIRED':
      return `This code has expired. ${SEND_AGAIN}`;
    case 'AUTH_MAGIC_LINK_USED':
      return `This code has already been used. ${SEND_AGAIN}`;
    case 'ACCOUNT_CLOSED':
      return 'This account was closed. Ask to join again, and you can sign in as soon as you are approved.';
    case 'USER_SUSPENDED':
      return 'This account is suspended. Please contact the REASON team if you think this is a mistake.';
    case 'RATE_LIMIT_EXCEEDED':
      return 'Too many codes tried. Please wait 15 minutes, then try again.';
    case 'VALIDATION_ERROR':
      return 'Enter the 6-digit code from the email.';
    default:
      return 'We could not check that code. Please try again.';
  }
}
