// ─── User Domain Types ───────────────────────────────────────────────────────

import type { OnboardingStatus } from './onboarding';

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  HOST = 'host',
  FOUNDING_MEMBER = 'founding_member',
  PRO = 'pro',
  MEMBER = 'member',
  FREE = 'free',
}

/** Role hierarchy: higher index = more privileges */
export const ROLE_HIERARCHY: UserRole[] = [
  UserRole.FREE,
  UserRole.MEMBER,
  UserRole.PRO,
  UserRole.FOUNDING_MEMBER,
  UserRole.HOST,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

/** Returns true when subject role is at or above the required role */
export function hasRoleAtLeast(subjectRole: UserRole, requiredRole: UserRole): boolean {
  return ROLE_HIERARCHY.indexOf(subjectRole) >= ROLE_HIERARCHY.indexOf(requiredRole);
}

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  BANNED = 'banned',
  DEACTIVATED = 'deactivated',
}

/**
 * What kind of account a users row is (Part 2, D2, 10 Nov 2026). A member is a full RSN account. An event guest is
 * the lightweight identity someone gets by joining an event from its link: they can take part in that event, but every
 * member-only part of RSN (people, messages, pods, circles, search) refuses them until they become a member through the
 * platform join request, whose approval turns the account into a member. Independent of the platform role.
 */
export type AccountKind = 'member' | 'event_guest';

export interface User {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  /** Where the member's banner is loaded from (GET /api/users/:id/banner?v=...), or null for the default one. */
  bannerUrl: string | null;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  xUrl: string | null;
  facebookUrl: string | null;
  interests: string[];
  reasonsToConnect: string[];
  languages: string[];
  timezone: string | null;
  phone: string | null;
  expertiseText: string | null;
  whatICareAbout: string | null;
  whatICanHelpWith: string | null;
  whoIWantToMeet: string | null;
  whyIWantToMeet: string | null;
  myIntent: string | null;
  professionalRole: string[];
  currentState: string | null;
  careerStage: string | null;
  goals: string[];
  meetingPreferences: string[];
  matchingNotes: string | null;
  invitedByUserId: string | null;
  role: UserRole;
  status: UserStatus;
  profileComplete: boolean;
  emailVerified: boolean;
  notifyEmail: boolean;
  notifyEventReminders: boolean;
  notifyMatches: boolean;
  profileVisible: boolean;
  inviteOptOutPublicEvents: boolean;
  /**
   * Shirley pilot S3 (RSN 14): members who open the profile see the circles and pods the member is in that they may
   * discover (on by default). Optional: an older server does not send it, and a screen reads a missing one as on.
   */
  showCommunities?: boolean;
  onboardingStatus?: OnboardingStatus;
  /** 2 once the member has finished the new onboarding; null before (an earlier one, or none). The preview gates on it. */
  onboardingVersion?: number | null;
  /** 'event_guest' for an attendee who joined from an event link and is not a member yet; 'member' otherwise. */
  accountKind?: AccountKind;
  lastOnboardedAt?: string | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The PUBLIC card — what any other member may see about you: who you are and
 * what you offer. Everything about why you're here (who you want to meet, why,
 * intent, interests, reasons to connect) stays on `User`, which only you and
 * admins receive (Stefan, 9 Sep 2026). Projected by the server; never widen
 * this on the client.
 */
export interface PublicMember {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  /** The banner across the top of their profile, or null for the default one. Public, like the photo. */
  bannerUrl: string | null;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
  /** Their website, Instagram, X and Facebook: each an address in the stored form (shared/src/profile/links.ts), or null. */
  websiteUrl: string | null;
  instagramUrl: string | null;
  xUrl: string | null;
  facebookUrl: string | null;
  languages: string[];
  professionalRole: string[];
  expertiseText: string | null;
  whatICanHelpWith: string | null;
}

/**
 * What a member's public profile link shows anyone who holds it, signed in or not (Shirley pilot S6, D5): the public
 * card, cut from PublicMember so it can only ever hold less (no member id), and what they can bring, worded as members
 * read it. Nothing else: no entities, no circles or pods, no way to message, call or meet them.
 */
export interface PublicProfileCard extends Omit<PublicMember, 'id'> {
  canBring: string | null;
}

/** A member's own public profile link. The token is sent to its owner and to nobody else. */
export interface PublicProfileLink {
  token: string;
  /** The page's path on the app, `/p/<token>`. The screen puts its own origin in front. */
  path: string;
  createdAt: string;
}

/**
 * The owner's view of their public link. `paused` says why a link that exists opens nothing right now: the member
 * chose not to be shown in search (profile_visible false), and a hidden profile is never opened by a stranger's link.
 */
export interface PublicProfileLinkState {
  link: PublicProfileLink | null;
  paused: 'hidden' | null;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  displayName?: string;
  linkedinUrl?: string | null;
}

export interface UpdateUserInput {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string | null;
  bio?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  industry?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  websiteUrl?: string | null;
  instagramUrl?: string | null;
  xUrl?: string | null;
  facebookUrl?: string | null;
  interests?: string[];
  reasonsToConnect?: string[];
  languages?: string[];
  timezone?: string | null;
  phone?: string | null;
  expertiseText?: string | null;
  whatICareAbout?: string | null;
  whatICanHelpWith?: string | null;
  whoIWantToMeet?: string | null;
  whyIWantToMeet?: string | null;
  myIntent?: string | null;
  notifyEmail?: boolean;
  notifyEventReminders?: boolean;
  notifyMatches?: boolean;
  profileVisible?: boolean;
  inviteOptOutPublicEvents?: boolean;
  showCommunities?: boolean;
}

export interface PremiumSelection {
  id: string;
  userId: string;
  sessionId: string;
  selectedUserId: string;
  createdAt: Date;
}
