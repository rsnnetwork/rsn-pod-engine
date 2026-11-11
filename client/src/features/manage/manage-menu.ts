// ─── The Manage menu of a circle or a pod (Shirley pilot S3, 11 Nov 2026; brief RSN 11) ──────────────────────────
// "Give owner a clear Manage menu: Edit details, Members, Invitations, Pods, Events, Visibility, Moderation, Export. Hide
// actions from users without permission." One list per space, in that order. An entry the viewer may not use is absent,
// never disabled, and a viewer with none sees no Manage button at all. The server's own flags decide (CircleAccess for
// a circle; the viewer's active pod role and platform role for a pod), and every route behind an entry refuses anyway.
//
// Who may use what (plan D3, D6; Shirley pilot S2):
//   Circle: its owner and moderators (canManage, which a platform admin also holds) edit its details, manage members,
//     see its invitations, add or attach pods, schedule its events and answer join requests. Only the owner (isOwner,
//     or a platform admin) chooses who can join (Visibility).
//   Pod: its director (or a platform admin) has every entry, plus Duplicate and Archive; a host has Members, Invitations,
//     Events and Moderation (the edit form holds the director-only visibility setting, so Edit details and Visibility
//     are the director's). An archived pod has only Export (its page offers Reactivate).
//   Export (D6; Shirley pilot S7's SpaceExportSheet): the page passes `exportReady`, which is S7's own rule on the
//     viewer's OWN role (mayExportCircle: owner or moderator; mayExportPod: an active director or host), never a
//     platform admin's powers (the server refuses those). It is the only place Export is offered on these pages, so it
//     is added whenever exportReady holds, whatever else the viewer may do, an archived pod included.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/shirley-s3-manage-communities.test.ts.

export type ManageKey =
  | 'edit' | 'members' | 'invitations' | 'pods' | 'circles' | 'events' | 'visibility' | 'moderation' | 'export'
  | 'duplicate' | 'archive';

export const MANAGE = 'Manage';

export const MANAGE_LABEL: Record<ManageKey, string> = {
  edit: 'Edit details',
  members: 'Members',
  invitations: 'Invitations',
  pods: 'Pods',
  circles: 'Circles',
  events: 'Events',
  visibility: 'Visibility',
  moderation: 'Moderation',
  export: 'Export',
  duplicate: 'Duplicate pod',
  archive: 'Archive pod',
};

/** The line under each entry: what it opens, in a member's words. */
export const CIRCLE_HINT: Partial<Record<ManageKey, string>> = {
  edit: 'Name and description',
  members: 'Roles, moderators and removing people',
  invitations: 'Who you invited, and withdrawing an invitation',
  pods: 'Make a new pod or attach one you run',
  events: 'Schedule an event for everyone in the circle',
  visibility: 'Who can join: Open or Closed',
  moderation: 'Join requests waiting for an answer',
  export: 'Download the circle\'s members, events and posts',
};

export const POD_HINT: Partial<Record<ManageKey, string>> = {
  edit: 'Name, description, type and rules',
  members: 'Hosts, members and removing people',
  invitations: 'Who is invited, who declined',
  circles: 'The circles this pod is in',
  events: 'Schedule an event for this pod',
  visibility: 'Private, Public with approval or Public open',
  moderation: 'Join requests and the discussion',
  export: 'Download the pod\'s members, events and posts',
  duplicate: 'A new pod with the same settings',
  archive: 'Hide it; its events are kept',
};

export interface CircleManageAccess {
  canManage?: boolean;
  isOwner?: boolean;
}

/** A circle's entries for this viewer, in the brief's order; Export whenever their own role exports (S7). */
export function circleManageKeys(c: CircleManageAccess, exportReady = false): ManageKey[] {
  const keys: ManageKey[] = [];
  if (c.canManage) {
    keys.push('edit', 'members', 'invitations', 'pods', 'events');
    if (c.isOwner) keys.push('visibility');
    keys.push('moderation');
  }
  if (exportReady) keys.push('export');
  return keys;
}

export interface PodManageAccess {
  /** The viewer's ACTIVE role in the pod, or null when they are not an active member. */
  role: 'director' | 'host' | 'member' | null;
  /** A platform admin (admin or super_admin): runs every pod as its director does. */
  platformAdmin: boolean;
  status: string;
  /** The pod is in at least one circle the viewer may see (its "In circles" chips are on the page). */
  inCircles: boolean;
}

/**
 * A pod's entries for this viewer, in the brief's order, then Duplicate and Archive for the director. Export whenever
 * their own role exports (S7), an archived pod included (its only entry there).
 */
export function podManageKeys(p: PodManageAccess, exportReady = false): ManageKey[] {
  const exp: ManageKey[] = exportReady ? ['export'] : [];
  if (p.status === 'archived') return exp;
  const director = p.role === 'director' || p.platformAdmin;
  if (director) {
    return [
      'edit', 'members', 'invitations', ...(p.inCircles ? ['circles' as const] : []), 'events', 'visibility', 'moderation',
      ...exp, 'duplicate', 'archive',
    ];
  }
  if (p.role === 'host') return ['members', 'invitations', 'events', 'moderation', ...exp];
  return exp;
}

/** The section on the page an entry scrolls to (the rest open a sheet or another screen). */
export const SECTION_ID = {
  circleMembers: 'circle-members',
  circlePods: 'circle-pods',
  podMembers: 'pod-members',
  podInvitations: 'pod-invitations',
  podCircles: 'pod-circles',
  podRequests: 'pod-requests',
  podDiscussion: 'pod-discussion',
} as const;
