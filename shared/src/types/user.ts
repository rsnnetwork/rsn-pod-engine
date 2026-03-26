// ─── User Domain Types ───────────────────────────────────────────────────────

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

export interface User {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  industry: string | null;
  location: string | null;
  linkedinUrl: string | null;
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
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserProfile {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  industry: string | null;
  interests: string[];
  reasonsToConnect: string[];
  expertiseText: string | null;
  whatICareAbout: string | null;
  whatICanHelpWith: string | null;
  whoIWantToMeet: string | null;
  whyIWantToMeet: string | null;
  myIntent: string | null;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  displayName?: string;
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
}

export interface PremiumSelection {
  id: string;
  userId: string;
  sessionId: string;
  selectedUserId: string;
  createdAt: Date;
}
