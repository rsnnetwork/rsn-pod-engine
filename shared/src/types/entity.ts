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
