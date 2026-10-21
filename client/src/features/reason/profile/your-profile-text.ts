// client/src/features/reason/profile/your-profile-text.ts
// What "Your profile" says, and where it links (21 Oct 2026). Pure on purpose (no React, axios, store or router),
// so a test can run it: server/src/__tests__/client/reason-your-profile.test.ts.
import { canBring, type PublicMember, type User } from '@rsn/shared';
import { visibleText } from '../person';

export const EDIT_PROFILE_TO = '/profile/edit';
// Task 9 opens the first question for editing; until then the address opens onboarding.
export const EDIT_ANSWERS_TO = '/onboarding?edit=q1';
// Task 11 wires creating your company; until then the address opens the Entities page.
export const ADD_COMPANY_TO = '/entities?create=1';
export const CONNECT_LINKEDIN_TO = '/profile/edit#linkedin';

/**
 * What you can bring, exactly as other members are shown it: canBring (@rsn/shared) is the rule their brief uses, so
 * a long offer is cut at 160 characters here too, and one with no letter or digit in it gives way to your expertise.
 */
export function youCanBring(card: Pick<PublicMember, 'whatICanHelpWith' | 'expertiseText'>): string | null {
  return canBring(card);
}

export interface PrivateRow { label: string; value: string | null; empty: string }

/** "Only you see this": what you want, which no other member is ever shown. */
export function privateRows(me: Pick<User, 'whoIWantToMeet' | 'myIntent' | 'whyIWantToMeet' | 'timezone'>): PrivateRow[] {
  return [
    { label: 'Who you want to meet', value: visibleText(me.whoIWantToMeet), empty: 'Not answered yet.' },
    // An older profile may say why they want to meet people and nothing as an intent.
    { label: "What you're hoping to find", value: visibleText(me.myIntent) ?? visibleText(me.whyIWantToMeet), empty: 'Not answered yet.' },
    { label: 'Time zone', value: visibleText(me.timezone), empty: 'Not set yet.' },
  ];
}

/** The card that asks for LinkedIn shows only while there is none on your card. */
export const needsLinkedin = (card: Pick<PublicMember, 'linkedinUrl'>): boolean => !visibleText(card.linkedinUrl);
