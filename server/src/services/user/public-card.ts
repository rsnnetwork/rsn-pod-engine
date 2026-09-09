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
