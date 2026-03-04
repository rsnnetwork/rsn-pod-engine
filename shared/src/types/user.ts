// ─── User Domain Types ───────────────────────────────────────────────────────

export enum UserRole {
  MEMBER = 'member',
  HOST = 'host',
  ADMIN = 'admin',
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
  role: UserRole;
  status: UserStatus;
  profileComplete: boolean;
  emailVerified: boolean;
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
}
