// client/src/features/reason/profile/your-profile-text.ts
// What "Your profile" says, and where it links (21 Oct 2026). Pure on purpose (no React, axios, store or router),
// so a test can run it: server/src/__tests__/client/reason-your-profile.test.ts.
import { canBring, type OnboardingV2Answers, type PublicMember } from '@rsn/shared';
import { answerSummary, questionFor, zoneLabel } from '../../onboarding/flow';
import { linkedinLink } from '../human/profile-text';
import { visibleText } from '../person';

export const EDIT_PROFILE_TO = '/profile/edit';
// Screen 7 in edit mode: every answer with its own [Edit], then back here (final review, 21 Oct 2026). The first
// question alone was a dead end. The old form's "Edit answers" opens it too.
export const EDIT_ANSWERS_TO = '/onboarding?edit=profile';
// The Entities page with "Create an entity" open, for your company.
export const ADD_COMPANY_TO = '/entities?create=1';
export const CONNECT_LINKEDIN_TO = '/profile/edit#linkedin';

/**
 * What you can bring, exactly as other members are shown it: canBring (@rsn/shared) is the rule their brief uses, so
 * a long offer is cut at 160 characters here too, and one with no letter or digit in it gives way to your expertise.
 */
export function youCanBring(card: Pick<PublicMember, 'whatICanHelpWith' | 'expertiseText'>): string | null {
  return canBring(card);
}

/** One part of "Only you see this": its lines, or what it says when there are none. */
export interface PrivateRow { label: string; lines: string[]; empty: string }

const some = (text: string | null): string[] => (text ? [text] : []);

/**
 * "Only you see this": what you want, which no other member is ever shown, as you answered it. The short labels and
 * your own words in quotes, exactly as screen 7 shows them (answerSummary), never the wording the matcher keeps for
 * them and never the reason given on the request form (final review, 21 Oct 2026). Then your time zone.
 */
export function privateRows(state: { answers: OnboardingV2Answers; profile: { timezone: string | null } }): PrivateRow[] {
  const zone = visibleText(state.profile.timezone);
  return [
    { label: 'Who you want to meet', lines: answerLines('q1', state.answers), empty: 'Not answered yet.' },
    { label: "What you're hoping to find", lines: answerLines('q2', state.answers), empty: 'Not answered yet.' },
    { label: 'Time zone', lines: some(zone && zoneLabel(zone)), empty: 'Not set yet.' },
  ];
}

/**
 * One question's answers as you gave them, the way screen 7 shows them: the short labels with your own words in quotes,
 * and for Q2 the specific wish on a line of its own. None when it is not answered. Your profile and the profile form
 * (what you can offer, who you want to meet, what you are hoping to find) both show them so.
 */
export function answerLines(step: 'q1' | 'q2' | 'q3', answers: OnboardingV2Answers): string[] {
  const specific = step === 'q2' ? visibleText(answers.findSpecific) : null;
  return [...some(visibleText(answerSummary(questionFor(step)!, answers))), ...(specific ? [`“${specific}”`] : [])];
}

/**
 * The card that asks for LinkedIn shows while the hero has no LinkedIn link to show: none on your card, or one it will
 * not link to (an http address, text that is no link). The same parse as the hero's (fix round 1, 21 Oct 2026).
 */
export const needsLinkedin = (card: Pick<PublicMember, 'linkedinUrl'>): boolean => linkedinLink(card.linkedinUrl) === null;
