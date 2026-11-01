// ─── Entities (21 Oct 2026) ──────────────────────────────────────────────────
// An Entity is an organisation people belong to or work with: a company, a fund, a university
// (Strategic Foundation, "ENTITY"). Members create their own and link themselves to it with a role
// (client feedback, 19 Oct: "Users should be able to create an Entity (their company) themselves").
//
// Not to be confused with the realtime "entity" tags of ENTITIES.md, which name what changed.
//
// The routes and the client read these lists. The CHECKs in migration 107 are the same lists written
// out, and migration-107.test.ts fails if the two ever differ. The VALUES here are rendered by the
// client, so index.ts also gives each its own named re-export (Rollup CJS interop; see OPENINGS there).

import type { PublicMember } from './user';

export const ENTITY_KINDS = [
  'company', 'startup', 'fund', 'university', 'community', 'charity', 'project',
  'investment_vehicle', 'association', 'other',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

// How a person relates to an entity, in the Foundation's own list.
export const ENTITY_ROLES = [
  'founder', 'employee', 'investor', 'advisor', 'board_member', 'partner', 'customer', 'member',
  'former_employee', 'fan', 'follower', 'other',
] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];

// The Foundation's words for each kind and role.
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  company: 'Company',
  startup: 'Startup',
  fund: 'Fund',
  university: 'University',
  community: 'Community',
  charity: 'Charity',
  project: 'Project',
  investment_vehicle: 'Investment vehicle',
  association: 'Association',
  other: 'Other',
};

export const ENTITY_ROLE_LABELS: Record<EntityRole, string> = {
  founder: 'Founder',
  employee: 'Employee',
  investor: 'Investor',
  advisor: 'Advisor',
  board_member: 'Board member',
  partner: 'Partner',
  customer: 'Customer',
  member: 'Member',
  former_employee: 'Former employee',
  fan: 'Fan',
  follower: 'Follower',
  other: 'Other',
};

// The roles that make the entity the member's own company. Creating or joining an entity with one
// of them fills in the member's profile company when it is empty.
export const COMPANY_ROLES: ReadonlyArray<EntityRole> = ['founder', 'employee'];

// One set of numbers, two readers: the routes validate against them and the forms count against them.
export const ENTITY_LIMITS = {
  nameMin: 2,
  nameMax: 200,
  aboutMax: 2000,
  locationMax: 200,
  sizeMax: 40,
  websiteMax: 500,
  titleMax: 120,
  /** A search shorter than this lists the most recently active entities instead. */
  searchMin: 2,
  searchMax: 200,
  /** The most entities `others` holds, searched or not. */
  othersMax: 30,
} as const;

// ─── What the API answers (GET /api/entities and the routes under it) ────────
// The 30 Oct review's fields (T15) are optional in these types so code built against the types before them still
// compiles; the server always sends every one of them.

/**
 * Where a person's link to an entity stands (30 Oct review, 7.2; L23). A claim waits as `pending` until one of the
 * entity's admins approves it (`active`) or declines it; an admin can remove an active member. Links made before the
 * review are all `active`. Only `active` links are listed anywhere, counted, or carry admin rights.
 */
export type EntityMemberStatus = 'pending' | 'active' | 'declined' | 'removed';

/** A change of role or title an active member asked for, waiting for an admin. */
export interface EntityPendingChange {
  role: EntityRole;
  title: string | null;
}

/** One entity in a list. `peopleCount` counts the people the viewer can see on its page. */
export interface EntitySummary {
  id: string;
  name: string;
  kind: EntityKind;
  location: string | null;
  peopleCount: number;
  /** The viewer's own role, or null when they are not linked to it. */
  myRole: EntityRole | null;
  /** 30 Oct review: the entity's logo (an absolute, versioned address), or null when it has none (the letter tile). */
  logoUrl?: string | null;
  /** 30 Oct review: 'pending' when the viewer's claim waits for approval (in `mine` only), 'active' when listed, else null. */
  myStatus?: 'active' | 'pending' | null;
}

/** GET /api/entities: the viewer's own entities, and others (a name search, or the most recently active). */
export interface EntityList {
  mine: EntitySummary[];
  others: EntitySummary[];
}

/** The entity itself, as its page shows it. */
export interface EntityInfo {
  id: string;
  name: string;
  kind: EntityKind;
  about: string | null;
  location: string | null;
  size: string | null;
  website: string | null;
  peopleCount: number;
  createdAt: string;
  updatedAt: string;
  /** 30 Oct review: the logo and the banner (absolute, versioned addresses), or null when there is none. */
  logoUrl?: string | null;
  bannerUrl?: string | null;
}

/** The thinnest public card: who someone is, and nothing of why they are here. */
export type PublicCardBasics = Pick<
  PublicMember,
  'id' | 'displayName' | 'firstName' | 'lastName' | 'avatarUrl' | 'jobTitle' | 'company' | 'location'
>;

/** A person on an entity's page. */
export interface EntityPerson extends PublicCardBasics {
  role: EntityRole;
  /** Their title at this entity ("CTO"), which can differ from the job title on their profile. */
  title: string | null;
  /** Can edit and archive the entity. */
  isAdmin: boolean;
}

/** Someone waiting for an entity's admins: a claim to be part of it, or an active member's change of role or title. */
export interface EntityRequest extends PublicCardBasics {
  kind: 'join' | 'change';
  /** What they say they are. */
  role: EntityRole;
  title: string | null;
  /** For a change: their role and title as listed now. Null for a claim. */
  currentRole: EntityRole | null;
  currentTitle: string | null;
  requestedAt: string;
}

/** A circle an entity is linked to. `memberCount` is null for a closed circle the viewer is outside (named only, L22). */
export interface EntityCircle {
  id: string;
  name: string;
  memberCount: number | null;
  joinPolicy: 'open' | 'closed';
}

/** An entity on a circle's page (GET /api/circles/:id, `entities`). */
export interface CircleEntityLink {
  id: string;
  name: string;
  kind: EntityKind;
  logoUrl: string | null;
}

/** GET /api/entities/:id */
export interface EntityPage {
  entity: EntityInfo;
  people: EntityPerson[];
  /** The viewer's role when their link is active, else null. */
  myRole: EntityRole | null;
  /** The viewer may edit and archive it: one of its admins, or a platform admin. */
  canEdit: boolean;
  /** 30 Oct review: where the viewer's own link stands, or null when they have none. */
  myStatus?: EntityMemberStatus | null;
  /** 30 Oct review: a change of role or title the viewer asked for, waiting for an admin. */
  myPendingChange?: EntityPendingChange | null;
  /** 30 Oct review: the circles it is linked to (at most 50). */
  circles?: EntityCircle[];
  /** 30 Oct review, only when `canEdit`: the people waiting for an answer (at most 200), and how many wait. */
  requests?: EntityRequest[];
  requestCount?: number;
}

/** One of a person's entities: GET /api/users/:id/entities, and the person brief's `entities`. */
export interface PersonEntity {
  id: string;
  name: string;
  kind: EntityKind;
  role: EntityRole;
  title: string | null;
  /** 30 Oct review: the entity's logo (an absolute, versioned address), or null. */
  logoUrl?: string | null;
  /** 30 Oct review, on a member's own list only: 'pending' for a claim that waits for approval. */
  status?: 'active' | 'pending';
}

/** POST /api/entities */
export interface CreateEntityResult {
  id: string;
  /** The creator's empty profile company was set to the entity's name. */
  companyUpdated: boolean;
}

/** POST /api/entities/:id/members: join, or change your own role. */
export interface EntityMembershipResult {
  /** true when this made a new link, false when it changed an existing one. */
  joined: boolean;
  role: EntityRole;
  title: string | null;
  isAdmin: boolean;
  /** The member's empty profile company was set to the entity's name. */
  companyUpdated: boolean;
  /** 30 Oct review: 'pending' when the claim waits for the entity's admins, 'active' when it was applied at once. */
  status?: EntityMemberStatus;
  /** 30 Oct review: a change of role or title that waits for the entity's admins, or null. */
  pendingChange?: EntityPendingChange | null;
}

/** DELETE /api/entities/:id/members/me */
export interface LeaveEntityResult {
  /** false when the member was not linked to it: nothing changed. */
  left: boolean;
  /** The member was the last person linked to it, so it was archived with them. */
  archived: boolean;
}
