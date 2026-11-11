// ─── A profile's Communities: words, links and tags (Shirley pilot S3, 11 Nov 2026; brief RSN 14) ───────────────
// The server decides which spaces are listed and each row's button (communities.service.ts); this turns a row into its
// words. Pure (no React, axios or store), so the server's jest runs it:
// server/src/__tests__/client/shirley-s3-manage-communities.test.ts.
import type { ProfileCommunities, ProfileCommunitiesHidden, ProfileCommunity, ProfileCommunityRole } from '@rsn/shared';
import { E } from '../../../realtime/entities';

export const COMMUNITIES_KICKER = 'Circles and pods';
/** The first page, and each page after it that "Show more" reads. */
export const FIRST_PAGE = 8;
export const MORE_PAGE = 24;

export const ROLE_LABEL: Record<ProfileCommunityRole, string> = {
  owner: 'Owner',
  moderator: 'Moderator',
  director: 'Director',
  host: 'Host',
  member: 'Member',
};

/**
 * The section's title: "Communities" and how many the VIEWER may see. It never claims to be every space the person is
 * in: the private and closed ones the viewer is not in are left out, and say nothing about how many there are.
 */
export function communitiesTitle(visible: number): string {
  return `Communities (${visible})`;
}

/** A row's kind and, when it is not open to all, how people get in. */
export function rowBadges(c: Pick<ProfileCommunity, 'kind' | 'access'>): string[] {
  const kind = c.kind === 'circle' ? 'Circle' : 'Pod';
  if (c.access === 'approval') return [kind, 'Approval'];
  if (c.access === 'members') return [kind, c.kind === 'circle' ? 'Closed' : 'Private'];
  return [kind];
}

export function spaceHref(c: Pick<ProfileCommunity, 'kind' | 'id'>): string {
  return c.kind === 'circle' ? `/circles/${c.id}` : `/pods/${c.id}`;
}

/**
 * The row's button: Join, Request to join, or Requested (waiting, not a button). A pod with rules to agree to first is
 * asked on its own page, where they are shown, so its button opens the pod. Nothing for a space you are in (the row
 * itself opens it) or that you cannot join yourself.
 */
export type RowButton =
  | { kind: 'call'; label: string; call: 'join-circle' | 'join-pod' | 'request-pod' }
  | { kind: 'link'; label: string; to: string }
  | { kind: 'waiting'; label: string }
  | null;

export function rowButton(c: ProfileCommunity): RowButton {
  if (c.action === 'pending') return { kind: 'waiting', label: 'Requested' };
  if (c.action === 'join') return { kind: 'call', label: 'Join', call: c.kind === 'circle' ? 'join-circle' : 'join-pod' };
  if (c.action === 'request') {
    if (c.hasJoinRules || c.kind === 'circle') return { kind: 'link', label: 'Request to join', to: spaceHref(c) };
    return { kind: 'call', label: 'Request to join', call: 'request-pod' };
  }
  return null;
}

/** What the member is told after a button's call answered. */
export function rowToast(call: 'join-circle' | 'join-pod' | 'request-pod', name: string): string {
  if (call === 'request-pod') return `Your request to join ${name} was sent. Its director will answer it.`;
  return `Welcome to ${name}!`;
}

/** Your own preview, when members are shown none of your communities: why, and what to do about it. */
export function previewEmptyText(hidden: ProfileCommunitiesHidden | null | undefined): string {
  if (hidden === 'setting_off') {
    return 'You turned off "Show my communities on my profile", so members see none. You can turn it on in Settings, under Privacy.';
  }
  if (hidden === 'hidden_from_search') {
    return 'You are hidden from search, so members see none of your communities. Show yourself in search again in Settings, under Privacy.';
  }
  return 'Members see none of your communities yet. Open circles and public pods you are in show here; private pods and closed circles never do.';
}

export const PREVIEW_NOTE = 'Members who share a private pod or a closed circle with you also see that one.';

/**
 * The tags the section follows. Your own joins, asks and blocks (user:<you>:circles, :pods, :blocks); their memberships
 * changing in a space you share with them, or their setting (user:<them>:circles, :pods, user:<them>); and each listed
 * space changing (its visibility, its members) when you are told of it: circle:<id>, circle:<id>:members, pod:<id>,
 * pod:<id>:members. A space you are not in, changed by someone else, is caught up on focus.
 */
export function communitiesEntities(me: string | undefined, them: string | undefined, pages: ProfileCommunities[] | undefined): string[] {
  const tags: string[] = [];
  if (me) tags.push(E.userCircles(me), E.userPods(me), E.userBlocks(me), E.user(me));
  if (them && them !== me) tags.push(E.userCircles(them), E.userPods(them), E.user(them));
  for (const page of pages ?? []) {
    for (const c of page.items) {
      if (c.kind === 'circle') tags.push(E.circle(c.id), E.circleMembers(c.id));
      else tags.push(E.pod(c.id), E.podMembers(c.id));
    }
  }
  return [...new Set(tags)];
}
