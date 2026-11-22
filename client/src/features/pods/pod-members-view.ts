// ─── A pod's member list: what it shows, in what order, and what its director may do (21 Nov 2026) ─────────────────
//
// Stefan, on the page of a 30-member pod he directs: "ux on how we show members, is really bad". The list sat in the
// page's 320px side column, every member a tall card with a Make Host button and a remove icon wrapped under the
// name, so 30 people were a long scroll beside an empty area. Now the members have the page's full width below the
// discussion and events, in compact rows (two or three across from 768px), with a search over name, title and
// company, the first 12 and "Show all", and the director's actions in a "⋯" menu on each row.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/pod-members-view.test.ts.

/**
 * A row of GET /pods/:id/members. The server declares it inline (pod.service getPodMembers), not in shared types:
 * shared's PodMember is the bare pod_members row. profileBadge is optional because the field is new (21 Nov 2026,
 * an admin's member badge) and an older server, or the pod's own read (pod.members), does not send it.
 */
export interface PodMemberRow {
  id: string;
  userId: string;
  role: string;
  status: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  profileBadge?: string | null;
}

/** The members shown before "Show all". */
export const MEMBERS_SHOWN_AT_FIRST = 12;
/** A list this long or longer has a search box; a pod of a few people does not need one. */
export const SEARCH_FROM = 7;
export const SEARCH_PLACEHOLDER = 'Search by name, title or company';
export const SHOW_FEWER = 'Show fewer';

export function showAllLabel(count: number): string {
  return `Show all ${count}`;
}

export function noMatchSentence(query: string): string {
  return `No members match ‘${query.trim()}’`;
}

export function memberName(m: Pick<PodMemberRow, 'displayName'>): string {
  return m.displayName?.trim() || 'Member';
}

/** "Founder · Acme", either half alone, or nothing. */
export function memberSubtitle(m: Pick<PodMemberRow, 'jobTitle' | 'company'>): string | null {
  const parts = [m.jobTitle, m.company].map((p) => p?.trim()).filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function memberRoleChip(role: string): 'Director' | 'Host' | null {
  if (role === 'director') return 'Director';
  if (role === 'host') return 'Host';
  return null;
}

/** Lower case, accents dropped, so "jose" finds José. Short strings only (a name, a title, a company). */
function fold(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFD')) {
    const code = ch.charCodeAt(0);
    // U+0300 to U+036F are the combining accents NFD splits off a letter (written as numbers, not as the marks).
    if (code < 0x0300 || code > 0x036f) out += ch;
  }
  return out.toLowerCase();
}

/** Every word of the search is somewhere in the member's name, job title or company. An empty search matches all. */
export function memberMatches(m: PodMemberRow, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold([m.displayName, m.jobTitle, m.company].filter(Boolean).join(' '));
  return words.every((w) => haystack.includes(w));
}

const ROLE_ORDER: Record<string, number> = { director: 0, host: 1 };

/** The director first, then the hosts, then everyone else, each group in the server's order (who joined first). */
export function orderByRole(members: readonly PodMemberRow[]): PodMemberRow[] {
  return members
    .map((m, i) => ({ m, i, r: ROLE_ORDER[m.role] ?? 2 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

/** The rows of a status chip: All (null) is the active members; any other chip is the rows in that status. */
export function membersInStatus(members: readonly PodMemberRow[], status: string | null): PodMemberRow[] {
  return members.filter((m) => m.status === (status ?? 'active'));
}

export interface PodMembersView {
  /** The rows to draw. */
  rows: PodMemberRow[];
  /** How many the chip lists before the search. */
  listed: number;
  /** How many the search leaves. */
  matched: number;
  /** Matches not drawn until "Show all". */
  hidden: number;
  /** "Show fewer" is offered: everything is drawn and that is more than the first page. */
  canShowFewer: boolean;
  /** The search box has words in it. */
  searching: boolean;
}

export function podMembersView(input: {
  members: readonly PodMemberRow[];
  status: string | null;
  query: string;
  showAll: boolean;
  shownAtFirst?: number;
}): PodMembersView {
  const cap = input.shownAtFirst ?? MEMBERS_SHOWN_AT_FIRST;
  const listed = membersInStatus(input.members, input.status);
  const matched = orderByRole(listed).filter((m) => memberMatches(m, input.query));
  const rows = input.showAll ? matched : matched.slice(0, cap);
  return {
    rows,
    listed: listed.length,
    matched: matched.length,
    hidden: matched.length - rows.length,
    canShowFewer: input.showAll && matched.length > cap,
    searching: input.query.trim() !== '',
  };
}

// ─── The status chips (the pod's director and hosts) ──────────────────────────────────────────────────────────────

export interface PodMemberCounts {
  active?: number;
  invited?: number;
  declined?: number;
  left?: number;
}

export type StatusChipKey = 'active' | 'invited' | 'declined' | 'left';
export interface StatusChip { key: StatusChipKey | null; label: string; count: number }

/** All (the members' total) and, for each status with someone in it, that status and its count. */
export function memberStatusChips(counts: PodMemberCounts, total: number): StatusChip[] {
  const named: { key: StatusChipKey; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'invited', label: 'Invited' },
    { key: 'declined', label: 'Declined' },
    { key: 'left', label: 'Left' },
  ];
  return [
    { key: null, label: 'All', count: total },
    ...named.flatMap((c) => ((counts[c.key] ?? 0) > 0 ? [{ ...c, count: counts[c.key] as number }] : [])),
  ];
}

// ─── The "⋯" menu of a row ────────────────────────────────────────────────────────────────────────────────────────

export type PodMemberAction = 'make-host' | 'remove-host' | 'remove';

export const MEMBER_ACTION_LABEL: Record<PodMemberAction, string> = {
  'make-host': 'Make host',
  'remove-host': 'Remove host',
  remove: 'Remove from pod',
};

/**
 * What the viewer may do to a row, the same rule the page always had: the pod's director or a platform admin
 * (canManage), never to themselves; the director's own role is not changed here; a role changes only for an active
 * member. The server decides every change; this only keeps the menu from offering what it would refuse.
 */
export function podMemberActions(m: PodMemberRow, viewer: { me: string | undefined; canManage: boolean }): PodMemberAction[] {
  if (!viewer.canManage || !m.userId || m.userId === viewer.me) return [];
  const out: PodMemberAction[] = [];
  if (m.role !== 'director' && m.status === 'active') out.push(m.role === 'host' ? 'remove-host' : 'make-host');
  out.push('remove');
  return out;
}

/** The role a role action asks the server for. */
export function roleFor(action: 'make-host' | 'remove-host'): 'host' | 'member' {
  return action === 'make-host' ? 'host' : 'member';
}
