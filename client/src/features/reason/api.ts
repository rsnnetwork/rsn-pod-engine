// client/src/features/reason/api.ts
// Everything the REASON pages read and write. Pages import all of it from here.
import api from '@/lib/api';
import type {
  MatchStrength, MeetingFormat, OutcomeKey, PersonBrief, PersonResponse, PublicMember,
  RecentConnection, User, WorthContinuing,
} from '@rsn/shared';
import type { PokeStatus } from './person';

// These live in modules with no axios or store behind them, so a test can run them (see errors.ts).
export { errorMessage } from './errors';
export { personName, stateFromPoke } from './person';

export interface ForYouMatch {
  userId: string;
  /** As the server types it: a member can have no name. Pages show it through personName(). */
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: string | null;
  company: string | null;
  industry: string | null;
  reason: string;
  theyCanBring: string | null;
  saved: boolean;
  strength: MatchStrength;
  pokeStatus: PokeStatus;
  pokeSentByOwner: boolean | null;
}

export interface ForYouPayload {
  matches: ForYouMatch[];
  profileIncomplete: boolean;
  youAreLookingFor: string | null;
  nextEvent: { id: string; title: string; scheduledAt: string } | null;
}

export const reasonKeys = {
  all: ['reason'] as const,
  forYou: ['reason', 'for-you'] as const,
  brief: (userId: string) => ['reason', 'brief', userId] as const,
  recent: ['reason', 'recent-connections'] as const,
  // Your own profile (21 Oct 2026): your card as others see it, and your whole profile. One prefix, so a banner
  // change refreshes both.
  mine: ['reason', 'mine'] as const,
  myCard: ['reason', 'mine', 'card'] as const,
  myProfile: ['reason', 'mine', 'profile'] as const,
  blockStatus: (userId: string) => ['reason', 'block-status', userId] as const,
};

// A member id is one encoded segment of an address. A route parameter arrives decoded, so a crafted
// "../people/connections/recent?" would otherwise be read as another route.
const memberSegment = (userId: string) => encodeURIComponent(userId);

export const fetchForYou = () => api.get('/matches/platform').then((r) => r.data.data as ForYouPayload);
export const fetchBrief = (userId: string) => api.get(`/people/${memberSegment(userId)}/brief`).then((r) => r.data.data as PersonBrief);
export const fetchRecentConnections = () => api.get('/people/connections/recent').then((r) => r.data.data as RecentConnection[]);
// Your own card, exactly as other members are shown it, and your whole profile, which only you are shown.
export const fetchMyCard = () => api.get('/people/me/card').then((r) => r.data.data as PublicMember);
export const fetchMyProfile = () => api.get('/users/me').then((r) => r.data.data as User);

export const setPersonResponse = (userId: string, response: PersonResponse | null) =>
  response
    ? api.put(`/people/${memberSegment(userId)}/response`, { response })
    : api.delete(`/people/${memberSegment(userId)}/response`);

export const sendMeetRequest = (userId: string, note: string, format: MeetingFormat) =>
  api.post(`/matches/platform/${memberSegment(userId)}/interest`, { note, format });

export const recordOutcomeRequest = (userId: string, worthContinuing: WorthContinuing, outcomes: OutcomeKey[]) =>
  api.post(`/people/${memberSegment(userId)}/outcome`, { worthContinuing, outcomes });

// Your banner: a data URL the page has already cropped to 1500x500, or none.
export const uploadBanner = (image: string) => api.put('/users/me/banner', { image });
export const removeBannerRequest = () => api.delete('/users/me/banner');

// The old public profile's block calls, with the id as one encoded segment like every call here. A profile you blocked
// is closed to you (the brief is a 404), so whether you are the one who blocked is asked on its own.
export const blockMember = (userId: string) => api.post(`/users/${memberSegment(userId)}/block`);
export const unblockMember = (userId: string) => api.delete(`/users/${memberSegment(userId)}/block`);
export const fetchBlockStatus = (userId: string) =>
  api.get(`/users/${memberSegment(userId)}/block-status`).then((r) => r.data.data as { hasBlocked: boolean });
