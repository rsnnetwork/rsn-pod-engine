// How the member chose on screen 2, remembered for the visit (this tab, through
// a refresh), per member.
//
// The server cannot tell the two apart: most members already have a LinkedIn
// result before they press anything (looked up when they were approved, from
// the link on their join form), and "Continue with email" changes nothing on
// the profile. So the choice is kept here, and only a LinkedIn choice lets
// LinkedIn suggest anything: screen 6's guess, screen 7's fields, its photo,
// its notes. Unknown (a new tab, another device) counts as not chosen, so
// LinkedIn is never presented as something they asked for; screen 7's
// [Add LinkedIn] turns it on again.

import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { parseSignupChoice, signupChoiceKey, type SignupChoice } from './flow';

function read(key: string | null): SignupChoice | null {
  if (!key) return null;
  try {
    return parseSignupChoice(sessionStorage.getItem(key));
  } catch {
    // Storage switched off (a locked-down browser): the choice holds for this page only.
    return null;
  }
}

export function useSignupChoice(): [SignupChoice | null, (choice: SignupChoice) => void] {
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
  return [choice, choose];
}
