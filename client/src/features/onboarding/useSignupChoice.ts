// How the member chose on screen 2, remembered for the visit (this tab, through
// a refresh), per member.
//
// The profile cannot tell the two apart: most members already have a LinkedIn
// result before they press anything (looked up when they were approved, from
// the link on their join form), and "Continue with email" changes nothing on
// the profile. So the choice is kept here, and only a LinkedIn choice lets
// LinkedIn suggest anything: screen 6's guesses, screen 7's fields, its photo,
// its notes. The server also records which button they pressed last
// (linkedin.chosen), and a tab that has no choice of its own, another tab or
// another device, follows that. With neither, it counts as not chosen, so
// LinkedIn is never presented as something they asked for; screen 7's
// [Add LinkedIn] turns it on again.

import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { parseSignupChoice, signupChoiceKey, signupChoiceOf, type SignupChoice } from './flow';

function read(key: string | null): SignupChoice | null {
  if (!key) return null;
  try {
    return parseSignupChoice(sessionStorage.getItem(key));
  } catch {
    // Storage switched off (a locked-down browser): the choice holds for this page only.
    return null;
  }
}

/** `onServer`: how the server last recorded the choice, for a tab that has none of its own. */
export function useSignupChoice(onServer: SignupChoice | null): [SignupChoice | null, (choice: SignupChoice) => void] {
  const memberId = useAuthStore(s => (s.user?.id as string | undefined) ?? undefined);
  const key = memberId ? signupChoiceKey(memberId) : null;
  const [choice, setChoice] = useState<SignupChoice | null>(() => read(key));
  const choose = (next: SignupChoice) => {
    setChoice(next);
    if (!key) return;
    try {
      sessionStorage.setItem(key, next);
    } catch {
      // As above: kept in this page only.
    }
  };
  return [signupChoiceOf(choice, onServer), choose];
}
