// ─── Public card (Stefan, 9 Sep 2026) ────────────────────────────────────────
//
// The profile that onboarding builds — why you're here, who you want to meet
// and why, your intent, interests, reasons to connect — is PRIVATE: only the
// member and admins see it. Everyone else sees the public card: who you are
// and what you offer. Matching and agents keep reading the full row on the
// server; this projection is only for what leaves the server about ANOTHER
// member. Every such read path goes through here, so a new private column
// added to `users` cannot leak by accident on some other screen.

import type { PublicMember, User } from '@rsn/shared';
import type { IntentProfile } from '../matching/platform-match.service';

/** Keys of `User` that must never reach another member. */
export const PRIVATE_MEMBER_KEYS: ReadonlySet<string> = new Set([
  // contact
  'email', 'phone', 'timezone',
  // why they are here / what they want
  'whoIWantToMeet', 'whyIWantToMeet', 'myIntent', 'goals', 'reasonsToConnect',
  'interests', 'whatICareAbout', 'matchingNotes', 'careerStage', 'currentState',
  'meetingPreferences',
  // account / prefs / lifecycle
  'invitedByUserId', 'notifyEmail', 'notifyEventReminders', 'notifyMatches',
  'profileVisible', 'inviteOptOutPublicEvents', 'onboardingStatus', 'lastOnboardedAt',
]);

/** The public card: who they are and what they offer — nothing about why they're here. */
export function toPublicMember(u: Partial<User> & { id: string }): PublicMember {
  return {
    id: u.id,
    displayName: u.displayName ?? '',
    firstName: u.firstName ?? '',
    lastName: u.lastName ?? '',
    avatarUrl: u.avatarUrl ?? null,
    bio: u.bio ?? null,
    company: u.company ?? null,
    jobTitle: u.jobTitle ?? null,
    industry: u.industry ?? null,
    location: u.location ?? null,
    linkedinUrl: u.linkedinUrl ?? null,
    languages: u.languages ?? [],
    professionalRole: u.professionalRole ?? [],
    expertiseText: u.expertiseText ?? null,
    whatICanHelpWith: u.whatICanHelpWith ?? null,
  };
}

/**
 * What a matching scorer may read about ANOTHER member when the screen can be aimed at any
 * member by id (the Human Profile brief): the public card's fields and nothing of why they
 * are here. The scorer counts a member's interests and what they care about as things they
 * offer, and words its reason from whatever matched, so a scorer given those fields spells
 * them out to whoever is looking (5 Oct 2026). Lists such as For You score the whole profile
 * on purpose, to choose whom to suggest, and never print a word from a private field.
 *
 * Every field is named here, so a field added to IntentProfile later is left out (or, when
 * it is required, fails the build) until someone decides it belongs on the public card.
 */
export function toPublicIntentProfile(p: IntentProfile): IntentProfile {
  return {
    id: p.id,
    displayName: p.displayName ?? null,
    avatarUrl: p.avatarUrl ?? null,
    professionalRole: p.professionalRole ?? null,
    jobTitle: p.jobTitle ?? null,
    // Provenance of the title, which decides which title the reason names. Not on the card, and says nothing about the member.
    jobTitleSource: p.jobTitleSource ?? null,
    company: p.company ?? null,
    expertiseText: p.expertiseText ?? null,
    whatICanHelpWith: p.whatICanHelpWith ?? null,
    industry: p.industry ?? null,
    bio: p.bio ?? null,
    location: p.location ?? null,
    // Private to the member (PRIVATE_MEMBER_KEYS): why they are here and what they want.
    whatICareAbout: null,
    goals: null,
    interests: null,
    myIntent: null,
    whoIWantToMeet: null,
    whyIWantToMeet: null,
  };
}

/**
 * Member / participant list rows for a NORMAL member: drop the email (and the
 * private `interests`). Admins, and hosts for their own event, keep the row as
 * is because they invite people by address.
 */
export function withoutEmail<T extends { email?: unknown; interests?: unknown }>(
  rows: T[],
): Omit<T, 'email' | 'interests'>[] {
  return rows.map((row) => {
    const { email: _e, interests: _i, ...rest } = row;
    return rest;
  });
}
