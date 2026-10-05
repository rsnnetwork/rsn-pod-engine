// Stefan's v4 navigation. People points at today's "Find people" until the
// People screen is rebuilt (next milestone); Entities and Introductions show an
// honest "coming next" page until then.
import type { ReasonIconName } from '../ui/icons';

export type NavKey = Exclude<ReasonIconName, 'more'>;
export interface NavItem { key: NavKey; label: string; to: string; match: (path: string) => boolean }

const under = (...prefixes: string[]) => (p: string) => prefixes.some(x => p === x || p.startsWith(`${x}/`));

export const MAIN_NAV: NavItem[] = [
  { key: 'foryou', label: 'For You', to: '/', match: (p) => p === '/' },
  { key: 'people', label: 'People', to: '/search', match: under('/search', '/agents', '/matches', '/encounters', '/people') },
  { key: 'entities', label: 'Entities', to: '/entities', match: under('/entities') },
  { key: 'circles', label: 'Circles', to: '/circles', match: under('/circles') },
  { key: 'pods', label: 'Pods', to: '/pods', match: under('/pods') },
  { key: 'events', label: 'Events', to: '/sessions', match: under('/sessions') },
  { key: 'messages', label: 'Messages', to: '/messages', match: under('/messages') },
  { key: 'introductions', label: 'Introductions', to: '/introductions', match: under('/introductions') },
];

export const SUB_NAV: NavItem[] = [
  { key: 'profile', label: 'Profile', to: '/profile', match: (p) => p === '/profile' },
  { key: 'settings', label: 'Settings', to: '/settings', match: under('/settings') },
  { key: 'support', label: 'Support', to: '/support', match: under('/support') },
];

export const NAV_BY_KEY = Object.fromEntries([...MAIN_NAV, ...SUB_NAV].map(i => [i.key, i])) as Record<NavKey, NavItem>;
export const MOBILE_PRIMARY: NavKey[] = ['foryou', 'people', 'events', 'messages'];
export const MOBILE_MORE: NavKey[] = ['entities', 'circles', 'pods', 'introductions', 'settings', 'support'];

// Invite and Admin are not in either list: they live in the account menu (in More on a
// phone), and that is what is marked current while a member is on one of them.
export const onInvites = under('/invites');
export const onAdmin = under('/admin');
export const isAccountPage = (path: string) => onInvites(path) || onAdmin(path);
