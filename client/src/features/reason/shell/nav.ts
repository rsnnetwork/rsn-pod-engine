// Stefan's v4 navigation. People opens Your connections, its first tab, until the
// People screen is rebuilt (next milestone); Entities is a page of its own (21 Oct).
// The prototype's Introductions tab was dropped on 19 Oct at the client's request:
// its icon stays in the icon set, but it is not a navigation key, so no list can
// name it (a key with no entry crashes the bar).
import type { ReasonIconName } from '../ui/icons';

export type NavKey = Exclude<ReasonIconName, 'more' | 'introductions'>;
export interface NavItem { key: NavKey; label: string; to: string; match: (path: string) => boolean }

const under = (...prefixes: string[]) => (p: string) => prefixes.some(x => p === x || p.startsWith(`${x}/`));

export const MAIN_NAV: NavItem[] = [
  { key: 'foryou', label: 'For You', to: '/', match: (p) => p === '/' },
  { key: 'people', label: 'People', to: '/connections', match: under('/connections', '/search', '/agents', '/matches', '/encounters', '/people') },
  { key: 'entities', label: 'Entities', to: '/entities', match: under('/entities') },
  { key: 'circles', label: 'Circles', to: '/circles', match: under('/circles') },
  { key: 'pods', label: 'Pods', to: '/pods', match: under('/pods') },
  // A meeting's own page (/meetings/:id, 26 Oct 2026) sits under Events with the events.
  { key: 'events', label: 'Events', to: '/sessions', match: under('/sessions', '/meetings') },
  { key: 'messages', label: 'Messages', to: '/messages', match: under('/messages') },
];

export const SUB_NAV: NavItem[] = [
  // Your profile and the form under it (/profile/edit). Another member's profile is /people/:id.
  { key: 'profile', label: 'Profile', to: '/profile', match: under('/profile') },
  { key: 'settings', label: 'Settings', to: '/settings', match: under('/settings') },
  { key: 'support', label: 'Support', to: '/support', match: under('/support') },
];

export const NAV_BY_KEY = Object.fromEntries([...MAIN_NAV, ...SUB_NAV].map(i => [i.key, i])) as Record<NavKey, NavItem>;
export const MOBILE_PRIMARY: NavKey[] = ['foryou', 'people', 'events', 'messages'];
export const MOBILE_MORE: NavKey[] = ['entities', 'circles', 'pods', 'settings', 'support'];

// Invite and Admin are not in either list: they live in the account menu (in More on a
// phone), and that is what is marked current while a member is on one of them.
export const onInvites = under('/invites');
export const onAdmin = under('/admin');
export const isAccountPage = (path: string) => onInvites(path) || onAdmin(path);
